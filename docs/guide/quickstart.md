# 安装与第一次验收

目标：让一个只读核对员读题面，向你提交一句发布说明的核对结果，然后停在用户验收。只有启动实例这一步才需要模型。

## 1. 检查日常 OpenCode

```sh
opencode --version
opencode service status
node --version
npm --version
```

请先确认日常 OpenCode 能正常对话，记下一个确实可用的 `provider/model` 以及服务地址。下面命令中的 `49374` 是示例端口，改成你已有服务的端口。不要另起 `opencode serve`。从 Release 解包后进入包含 `package.json` 的目录，或拉取预发布标签：

```sh
git clone --branch v0.1.0-alpha.2 --depth 1 https://github.com/patslw/opencode-teamflow.git
cd opencode-teamflow
npm ci
npm run typecheck
npm run build
npm run demo:prepare -- --endpoint http://127.0.0.1:49374
```

`demo:prepare` 在 `.runtime/demo-project/` 写入项目级服务插件配置，在 `.runtime/backends.json` 写入允许访问的项目；不覆盖已有文件，也不修改全局 OpenCode 配置。若机器上已有配置，以自己的配置为准。

## 2. 安装角色并导入练习

```sh
# 改成你的日常 OpenCode 已能实际调用的模型
MODEL='openai/gpt-6.1-terra'
node scripts/install-collaboration.mjs .runtime/demo-project "$MODEL"
npm run demo:example -- "$MODEL"
```

成功时会打印「第一次体验：核对发布说明」、版本 ID 和目标项目。重复运行相同配置会复用版本；导入不会创建团队、发送消息或消耗模型额度。模型出现在列表不代表认证一定成功。

```sh
npm run demo:web
```

保持终端运行，在浏览器打开 **http://127.0.0.1:3180/**。远程使用可在服务器上指定 `--host` 后从浏览器直接访问 HTTPS，也可保留回环入口、在自己电脑执行 `ssh -N -L 3180:127.0.0.1:3180 <SSH主机别名>`。见[网络配置](network.md)。

## 3. 从题面到验收

1. **先对项目。** 网页顶部显示的是模型会工作的目录。选刚导入的「第一次体验：核对发布说明」。点击「核对发布说明」节点，查看角色、提示词和交付要求。
2. **启动。** 给实例起个容易认出的名字，例如 `我的第一次验收`。说明填「请核对题面上的版本号」。点击「启动已发布版本」，确认后才会派工。
3. **看证据。** 打开这个实例，选核对员，查看它自己的会话。它应按题面提交摘要与产物引用。若只聊了句“完成”而未提交，流程不会假装进入验收。
4. **由你决定。** 「由你验收」显示等待时，对照摘要和版本号。批准会到达「结束」；打回并填写理由会生成新一轮核对，上一轮仍可查看。不要对不打算验收的其他实例操作。

### 我更常用 TUI

另开一个终端，在同一安装目录执行：

```sh
npm run demo:tui -- local "$(pwd)/.runtime/demo-project"
```

在已有的顶层聊天输入 `/teamflow`（或 `Ctrl+P` 搜索 `Teamflow`）。从「启动流程」发起时，这条聊天本身就是主入口。以后选「此主会话的团队」进入已有实例，不必重新启动。

若已经从网页启动，请选「查看实例与成员」找到上一步的实例，再选「打开原生团队主会话」。从团队菜单进入成员私聊、查看议题或暂停/恢复。默认 Sessions 列表里找主入口即可，私聊不需要另开普通聊天。命令只给这次 TUI 进程加载客户端插件；若使用已有安装，把示例目录换成网页顶部的实际目录。

如果无法连到服务或成员没有回复，不要反复点击「启动」；先看[排错](operations.md)。
