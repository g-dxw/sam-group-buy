#!/usr/bin/env python3
"""Local, read-only Sam's Club product browser. Python standard library only."""
import argparse
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API_BASE = "https://api-sams.walmartmobile.cn/api/v1/sams/"
HEADERS = {
    "Content-Type": "application/json;charset=UTF-8",
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "SamClub/5.0.45 (iPhone; iOS 15.4; Scale/3.00)",
    "device-type": "mini_program",
    "rcs": "6",
    "system-language": "zh_CN",
    "Origin": "https://m-sams.walmartmobile.cn",
    "Referer": "https://m-sams.walmartmobile.cn/",
}
KINDS = {2: "会员店", 4: "极速达", 8: "全球购", 256: "电商配送"}
CACHE = {}
STORE_NAMES = {}
CACHE_LOCK = threading.Lock()
UPSTREAM_LIMIT = threading.BoundedSemaphore(3)


class APIError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def upstream(path, body, ttl=60):
    """Call a fixed read-only endpoint; cache successful responses briefly."""
    key = (path, json.dumps(body, sort_keys=True, ensure_ascii=False))
    with CACHE_LOCK:
        old = CACHE.get(key)
        if old and time.monotonic() - old[0] < ttl:
            return old[1], old[2], True
    if not UPSTREAM_LIMIT.acquire(timeout=1):
        raise APIError("正在处理其他查询，请稍后重试。", 503)
    try:
        request = urllib.request.Request(
            API_BASE + path,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers=HEADERS,
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=12) as response:
            raw = response.read(5 * 1024 * 1024 + 1)
        if len(raw) > 5 * 1024 * 1024:
            raise APIError("返回结果过大，请缩小查询范围。")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise APIError("商品服务返回了无法识别的数据。")
        if result.get("code") != "Success":
            code = result.get("code", "")
            if code == "AUTH_FAIL":
                raise APIError("此查询需要登录，目前无法匿名获取。")
            raise APIError("商品服务暂时无法完成查询，请稍后重试。")
        queried_at = utc_now()
        with CACHE_LOCK:
            if len(CACHE) >= 300:
                oldest = min(CACHE, key=lambda entry: CACHE[entry][0])
                del CACHE[oldest]
            CACHE[key] = (time.monotonic(), result, queried_at)
        return result, queried_at, False
    except urllib.error.HTTPError as exc:
        if exc.code in (403, 429):
            raise APIError("查询过于频繁，商品服务暂时限制访问，请稍后重试。", 503) from exc
        raise APIError("商品服务暂时不可用，请稍后重试。") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise APIError("连接商品服务超时或失败，请稍后重试。", 504) from exc
    except (ValueError, UnicodeError) as exc:
        raise APIError("商品服务返回了无法识别的数据。") from exc
    finally:
        UPSTREAM_LIMIT.release()


def cities():
    result, queried_at, cached = upstream("merchant/storeApi/allAddressList", {}, ttl=3600)
    rows = (result.get("data") or {}).get("list", [])
    unique = {}
    for row in rows:
        code = str(row.get("cityCode") or "")
        name = row.get("cityName")
        if re.fullmatch(r"\d{6}", code) and isinstance(name, str) and name:
            unique[code] = {
                "city_code": code,
                "city_name": name,
                "province_name": row.get("provinceName"),
                "initial": row.get("cityInitial", ""),
            }
    if not unique:
        raise APIError("暂时没有可选择的城市，请稍后重试。")
    return {
        "cities": sorted(unique.values(), key=lambda row: (row["initial"], row["city_name"])),
        "default_city_code": "440300",
        "queried_at": queried_at,
        "cached": cached,
    }


def normalize_store(row):
    store_id = str(row.get("storeId") or "")
    if str(row.get("storeType")) not in {str(value) for value in KINDS}:
        return None
    try:
        store_type = int(row.get("storeType"))
    except (ValueError, TypeError):
        return None
    if not re.fullmatch(r"\d{1,12}", store_id) or store_type not in KINDS:
        return None
    name = row.get("storeName")
    if not isinstance(name, str) or not name:
        name = f"门店 {store_id}"
    return {"store_id": store_id, "store_type": store_type, "name": name, "kind": KINDS[store_type]}


def stores(city_code):
    known = {row["city_code"] for row in cities()["cities"]}
    if city_code not in known:
        raise APIError("请选择列表中的城市。", 400)
    # This exact request is used by the official public H5 store-map page.
    result, queried_at, cached = upstream(
        "merchant/storeApi/getStoreListByCityCodePlus", {"cityCode": city_code}, ttl=3600
    )
    rows = result.get("data") or []
    if not isinstance(rows, list):
        raise APIError("暂时无法读取该城市的门店列表，请稍后重试。")
    normalized = [item for row in rows if (item := normalize_store(row))]
    normalized.sort(key=lambda row: (row["store_id"] != "6505", row["store_type"] != 2, row["name"]))
    with CACHE_LOCK:
        for row in normalized:
            STORE_NAMES[(row["store_id"], row["store_type"])] = row["name"]
    warning = None if normalized else "该城市暂时没有返回可查询的门店，请尝试其他城市。"
    return {"city_code": city_code, "stores": normalized, "warning": warning, "queried_at": queried_at, "cached": cached}


def normalize_product(item):
    price = None
    for entry in item.get("priceInfo") or []:
        if entry.get("priceType") == 1:
            try:
                cents = int(entry["price"])
                if cents >= 0:
                    price = cents / 100
            except (ValueError, TypeError, KeyError):
                pass
            break
    image = item.get("image")
    try:
        parsed_image = urllib.parse.urlsplit(image) if isinstance(image, str) else None
        if not parsed_image or parsed_image.scheme not in ("http", "https") or not parsed_image.hostname:
            image = None
    except ValueError:
        image = None
    return {
        "spu_id": str(item.get("spuId") or ""),
        "name": str(item.get("title") or "未命名商品"),
        "description": str(item.get("subTitle") or ""),
        "price_cny": price,
        "price_label": "销售价",
        "image_url": image,
        "available": item.get("isAvailable") if isinstance(item.get("isAvailable"), bool) else None,
        "on_sale": item.get("isPutOnSale") if isinstance(item.get("isPutOnSale"), bool) else None,
    }


def search(params):
    keyword = params.get("keyword", "").strip()
    store_id = params.get("storeId", "")
    if not keyword or len(keyword) > 80:
        raise APIError("请输入 1 至 80 个字符的商品关键词。", 400)
    if not re.fullmatch(r"\d{1,12}", store_id):
        raise APIError("请选择门店，或输入有效的门店编号。", 400)
    try:
        store_type = int(params.get("storeType", "2"))
        page = int(params.get("page", "1"))
    except (ValueError, TypeError):
        raise APIError("门店类型或页码无效。", 400)
    if store_type not in KINDS or not 1 <= page <= 100:
        raise APIError("门店类型或页码无效。", 400)
    started = time.monotonic()
    result, queried_at, cached = upstream("goods-portal/spu/search", {
        "keyword": keyword,
        "pageNum": page,
        "pageSize": 20,
        "storeInfoVOList": [{"storeType": store_type, "storeId": store_id}],
    })
    data = result.get("data") or {}
    rows = data.get("dataList") or []
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise APIError("商品服务返回了无法识别的数据。")
    # Never silently label results with a different requested store.
    if any(str(row.get("storeId")) != store_id for row in rows):
        raise APIError("商品服务返回的门店与选择不一致，请重新选择门店。")
    if any("storeType" in row and str(row["storeType"]) != str(store_type) for row in rows):
        raise APIError("商品服务返回的门店与选择不一致，请重新选择门店。")
    with CACHE_LOCK:
        store_name = STORE_NAMES.get((store_id, store_type))
    return {
        "query": keyword,
        "store": {"store_id": store_id, "store_type": store_type, "name": store_name},
        "page": page,
        "page_size": 20,
        "total": data.get("totalCount", len(rows)),
        "has_more": data.get("hasNextPage") is True,
        "queried_at": queried_at,
        "cached": cached,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "products": [normalize_product(row) for row in rows],
    }


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, content_type="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' https: http: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # Local service is intentionally restricted to loopback and valid Host values.
        host = self.headers.get("Host", "").split(":", 1)[0]
        if host not in ("127.0.0.1", "localhost"):
            return self.send(403, {"error": "仅支持本机访问。"})
        url = urllib.parse.urlsplit(self.path)
        params = {key: values[-1] for key, values in urllib.parse.parse_qs(url.query, keep_blank_values=True).items()}
        try:
            if url.path == "/api/cities":
                return self.send(200, cities())
            if url.path == "/api/stores":
                return self.send(200, stores(params.get("cityCode", "440300")))
            if url.path == "/api/search":
                return self.send(200, search(params))
            files = {"/": "index.html", "/index.html": "index.html", "/styles.css": "styles.css", "/app.js": "app.js"}
            if url.path in files:
                path = ROOT / files[url.path]
                mime = {".html": "text/html", ".css": "text/css", ".js": "text/javascript"}[path.suffix]
                return self.send(200, path.read_bytes(), mime + "; charset=utf-8")
            return self.send(404, {"error": "页面不存在。"})
        except APIError as exc:
            self.send(exc.status, {"error": str(exc)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.send(500, {"error": "本地查询服务遇到问题，请稍后重试。"})

    def log_message(self, format, *args):
        # Don't log product query strings or private application state.
        print(f"[{self.log_date_time_string()}] {args[1] if len(args) > 1 else 'request'}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=64343)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"山姆商品查询：http://127.0.0.1:{server.server_port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
