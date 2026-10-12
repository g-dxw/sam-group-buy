# 山姆商品查询页面

本地独立查询工具，使用 Python 标准库，无需安装额外依赖。它读取公开匿名接口，支持选择城市和实体门店，搜索商品名称、销售价、图片地址及可售状态。不会向现有团购系统或飞书写入商品。

```sh
python3 tools/sams-browser/server.py
```

打开 <http://127.0.0.1:64343/>。也可使用 `--port 64344` 改端口。服务仅监听本机，按 Ctrl+C 停止。

本地检查：`python3 -m unittest discover -s tools/sams-browser -p 'test_server.py'`；前端语法检查：`node --check tools/sams-browser/app.js`。

城市来自 `merchant/storeApi/allAddressList`；实体门店来自 `merchant/storeApi/getStoreListByCityCodePlus`，请求为 `{"cityCode":"440300"}`。后者与官方公开 H5 门店地图使用的调用一致。验证记录在 `.artifacts/sams-interface-research/store-discovery-agent/`，北京、深圳、重庆已实测返回门店。

商品来自 `goods-portal/spu/search`，每页 20 条，由页面手动“加载更多”。只把 `priceInfo` 中 `priceType=1` 的销售价转换为人民币元，缺价显示未知。原始价为零不会被用作销售价。商品编号使用真实 `spuId`，不将它冒充 SKU。

价格和可售状态表示所选门店接口本次显示的结果；搜索可能返回相关商品，不保证全国全量或实际配送可达。页面标注查询时间，商品查询缓存 60 秒、门店及城市列表缓存 1 小时；重新启动清空缓存。JSON 导出含已加载结果、图片地址、门店和查询时间，不包含本地图片文件。

实现参考：

- [sku-scout 中国山姆适配器](https://github.com/ChanceFlow/sku-scout/blob/3e3c649895fa2f1a68a2bf0451c61d6bb441a328/src/platforms/samsclub-cn.mjs)
- [山姆官方 H5 公开页面脚本](https://mcdn-sams.walmartmobile.cn/index-1789137492058-0ff4cc57.js)
- [山姆官方 H5 公开接口定义](https://mcdn-sams.walmartmobile.cn/assets/index.b3d2fd37.js)

未执行参考项目的外部代码。此工具只实现匿名读取所需请求，不需要用户令牌、会员号、地址或浏览器登录态。
