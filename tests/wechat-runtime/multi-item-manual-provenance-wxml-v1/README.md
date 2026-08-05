# 多商品人工来源 WXML 门禁 V1

本目录把证据分成两个等级，禁止混报：

- `contract-tests.js`：源码静态合同 + 真实生产 Page VM。验证数据、事件、安全、preflight、business/storage 调用计数，但不能证明微信 WXML 渲染时序。
- `run.js`：通过 `miniprogram-automator` 启动微信开发者工具，验证真实 WXML 的节点复用、输入、删除、可见警告和按钮 disabled 状态。它不是 iOS/Android 真机证据。

运行确定性合同：

```bash
node tests/wechat-runtime/multi-item-manual-provenance-wxml-v1/contract-tests.js
```

运行真实微信开发者工具：

```bash
WECHAT_EXPECTED_HEAD="$(git rev-parse HEAD)" \
  node tests/wechat-runtime/multi-item-manual-provenance-wxml-v1/run.js
```

前置条件：微信开发者工具已安装并开启服务端口。必须用 `WECHAT_EXPECTED_HEAD` 显式绑定候选完整 HEAD；可用 `WECHAT_EXPECTED_BRANCH`、`WECHAT_CLI_PATH` 和 `WECHAT_AUTOMATION_PORT` 覆盖默认分支、CLI 路径和端口。runner 会拒绝暂存区内容、白名单外工作树文件或错误页面路由，并输出候选源码 SHA-256 与元素真实尺寸。

专项覆盖：稳定 `confirmationItemKey`、同名不同规格、编辑隔离、新增、删除、合法重排、阻断原因可见、补齐后提示消失以及按钮状态同步。精确 business/saveState 调用数只能由 Page VM 观测；DevTools 只证明真实渲染与最终页面状态。
