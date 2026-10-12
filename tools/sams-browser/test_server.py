"""Pure local contracts for the Sam's browser. Network access is always mocked."""
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("sams_browser_server", Path(__file__).with_name("server.py"))
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


def product(**changes):
    row = {
        "spuId": "product-1", "title": "测试商品", "storeId": "6505", "storeType": 2,
        "priceInfo": [{"priceType": 1, "price": "7990"}, {"priceType": 2, "price": "0"}],
        "image": "http://image.example.test/item.jpg", "isAvailable": None, "isPutOnSale": None,
    }
    row.update(changes)
    return row


def envelope(rows, **changes):
    data = {"dataList": rows, "totalCount": len(rows), "hasNextPage": False}
    data.update(changes)
    return {"code": "Success", "data": data}, "2026-10-12T10:00:00+00:00", False


class LocalTestCase(unittest.TestCase):
    def setUp(self):
        with server.CACHE_LOCK:
            server.CACHE.clear()
            server.STORE_NAMES.clear()
        self.no_network = patch.object(
            server.urllib.request, "urlopen", side_effect=AssertionError("Tests must never reach an upstream service")
        )
        self.no_network.start()
        self.addCleanup(self.no_network.stop)


class ProductNormalizationTests(LocalTestCase):
    def test_sales_price_is_cents_divided_by_100(self):
        for cents, expected in [("7990", 79.9), (5690, 56.9), (1, 0.01), ("0", 0.0)]:
            with self.subTest(cents=cents):
                actual = server.normalize_product(product(priceInfo=[{"priceType": 1, "price": cents}]))
                self.assertEqual(actual["price_cny"], expected)

    def test_type_2_is_never_used_as_a_sales_price(self):
        for price_info in [[], [{"priceType": 2, "price": "0"}], [{"priceType": 2, "price": "8990"}]]:
            with self.subTest(price_info=price_info):
                self.assertIsNone(server.normalize_product(product(priceInfo=price_info))["price_cny"])

    def test_invalid_sales_price_stays_unknown_instead_of_using_type_2(self):
        for invalid in [None, "bad", -1]:
            with self.subTest(invalid=invalid):
                row = product(priceInfo=[{"priceType": 1, "price": invalid}, {"priceType": 2, "price": "0"}])
                self.assertIsNone(server.normalize_product(row)["price_cny"])

    def test_missing_status_is_unknown_not_unavailable(self):
        for status, expected in [(None, None), (0, None), (1, None), ("false", None), (False, False), (True, True)]:
            with self.subTest(status=status):
                result = server.normalize_product(product(isAvailable=status, isPutOnSale=status))
                self.assertIs(result["available"], expected)
                self.assertIs(result["on_sale"], expected)

    def test_http_and_https_product_images_are_preserved(self):
        for image in ["http://image.example.test/item.jpg", "https://image.example.test/item.jpg"]:
            with self.subTest(image=image):
                self.assertEqual(server.normalize_product(product(image=image))["image_url"], image)

    def test_non_http_images_are_rejected(self):
        for image in [None, "javascript:alert(1)", "file:///tmp/image.jpg", "data:image/png;base64,eA=="]:
            with self.subTest(image=image):
                self.assertIsNone(server.normalize_product(product(image=image))["image_url"])

    def test_malformed_http_images_do_not_break_the_product_result(self):
        for image in ["https://", "http:///missing-host.jpg", "http://["]:
            with self.subTest(image=image):
                self.assertIsNone(server.normalize_product(product(image=image))["image_url"])


class SearchContractsTests(LocalTestCase):
    params = {"keyword": "牛奶", "storeId": "6505", "storeType": "2", "page": "1"}

    def test_bad_query_parameters_are_rejected_before_upstream(self):
        bad_changes = [
            {"keyword": " "}, {"keyword": "a" * 81}, {"storeId": ""}, {"storeId": "abc"},
            {"storeId": "1" * 13}, {"storeType": "3"}, {"storeType": "bad"}, {"page": "0"},
            {"page": "101"}, {"page": "1.5"}, {"page": ""},
        ]
        with patch.object(server, "upstream") as upstream:
            for changes in bad_changes:
                with self.subTest(changes=changes), self.assertRaises(server.APIError) as error:
                    server.search({**self.params, **changes})
                self.assertEqual(error.exception.status, 400)
            upstream.assert_not_called()

    def test_store_and_page_are_sent_and_returned_consistently(self):
        for store_type in (2, 4, 8, 256):
            with self.subTest(store_type=store_type):
                with patch.object(server, "upstream", return_value=envelope([product(storeType=store_type)])) as upstream:
                    result = server.search({**self.params, "storeType": str(store_type), "page": "2"})
                body = upstream.call_args.args[1]
                self.assertEqual(body["storeInfoVOList"], [{"storeType": store_type, "storeId": "6505"}])
                self.assertEqual(body["pageNum"], 2)
                self.assertEqual(result["store"]["store_id"], "6505")
                self.assertEqual(result["store"]["store_type"], store_type)
                self.assertEqual(result["products"][0]["price_cny"], 79.9)

    def test_different_returned_store_is_rejected(self):
        with patch.object(server, "upstream", return_value=envelope([product(storeId="6600")])):
            with self.assertRaises(server.APIError):
                server.search(self.params)

    def test_missing_returned_store_is_not_assumed_to_match(self):
        row = product()
        del row["storeId"]
        with patch.object(server, "upstream", return_value=envelope([row])):
            with self.assertRaises(server.APIError):
                server.search(self.params)

    def test_different_explicit_returned_store_type_is_rejected(self):
        with patch.object(server, "upstream", return_value=envelope([product(storeType=4)])):
            with self.assertRaises(server.APIError):
                server.search(self.params)

    def test_string_false_does_not_mean_there_is_a_next_page(self):
        with patch.object(server, "upstream", return_value=envelope([product()], hasNextPage="false")):
            self.assertFalse(server.search(self.params)["has_more"])


class StoreSelectionTests(LocalTestCase):
    def test_store_types_use_supported_integer_values_without_coercing_bad_types(self):
        for kind in [2, "2", 4, "4", 8, "8", 256, "256"]:
            with self.subTest(kind=kind):
                self.assertEqual(server.normalize_store({"storeId": "6505", "storeType": kind})["store_type"], int(kind))
        for invalid in [True, False, 2.5, "2.5", "3", None]:
            with self.subTest(invalid=invalid):
                self.assertIsNone(server.normalize_store({"storeId": "6505", "storeType": invalid}))

    def test_non_default_city_uses_its_official_store_list_and_store_names_are_type_specific(self):
        upstream_result = {
            "code": "Success", "data": [
                {"storeId": "6600", "storeType": "2", "storeName": "贵阳会员店"},
                {"storeId": "6600", "storeType": 4, "storeName": "贵阳极速达"},
            ],
        }
        with patch.object(server, "cities", return_value={"cities": [{"city_code": "520100"}]}):
            with patch.object(server, "upstream", return_value=(upstream_result, "2026-10-12T10:00:00+00:00", False)) as upstream:
                result = server.stores("520100")
        self.assertEqual(result["city_code"], "520100")
        self.assertEqual({row["store_type"] for row in result["stores"]}, {2, 4})
        self.assertIsNone(result["warning"])
        upstream.assert_called_once_with("merchant/storeApi/getStoreListByCityCodePlus", {"cityCode": "520100"}, ttl=3600)
        for kind, expected_name in [(2, "贵阳会员店"), (4, "贵阳极速达")]:
            with self.subTest(kind=kind):
                with patch.object(server, "upstream", return_value=envelope([product(storeId="6600", storeType=kind)])):
                    searched = server.search({**SearchContractsTests.params, "storeId": "6600", "storeType": str(kind)})
                self.assertEqual(searched["store"]["name"], expected_name)


class CacheIsolationTests(LocalTestCase):
    def test_cached_queries_are_isolated_by_store_id_and_type(self):
        calls = []

        def fake_response(request, timeout):
            body = json.loads(request.data)
            calls.append(body)
            row = product(**body["storeInfoVOList"][0])
            return io.BytesIO(json.dumps(envelope([row])[0]).encode())

        with patch.object(server.urllib.request, "urlopen", side_effect=fake_response):
            for store_id, store_type, expected_cached in [("6505", 2, False), ("6505", 2, True), ("6600", 2, False), ("6505", 4, False)]:
                with self.subTest(store_id=store_id, store_type=store_type):
                    body = {"keyword": "牛奶", "storeInfoVOList": [{"storeId": store_id, "storeType": store_type}]}
                    response, _, cached = server.upstream("goods-portal/spu/search", body)
                    self.assertIs(cached, expected_cached)
                    self.assertEqual(response["data"]["dataList"][0]["storeId"], store_id)
                    self.assertEqual(response["data"]["dataList"][0]["storeType"], store_type)
        self.assertEqual(len(calls), 3)

    def test_unsuccessful_response_is_not_cached(self):
        bad = io.BytesIO(json.dumps({"code": "AUTH_FAIL"}).encode())
        good = io.BytesIO(json.dumps(envelope([])[0]).encode())
        body = {"keyword": "牛奶", "storeInfoVOList": [{"storeId": "6505", "storeType": 2}]}
        with patch.object(server.urllib.request, "urlopen", side_effect=[bad, good]) as urlopen:
            with self.assertRaises(server.APIError):
                server.upstream("goods-portal/spu/search", body)
            self.assertFalse(server.upstream("goods-portal/spu/search", body)[2])
            self.assertTrue(server.upstream("goods-portal/spu/search", body)[2])
        self.assertEqual(urlopen.call_count, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
