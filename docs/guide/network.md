# 多服务器：访问网页与选择后端

`--host` 和 `--port` 决定**浏览器连到哪里**。`.runtime/backends.json` 决定**模型在哪台机器执行、读哪个项目**。可以每台服务器各开网页，也可以在 A 机器上开一个网页，登记 A、B 的 OpenCode 并在顶部切换。

## 从自己的电脑打开服务器的网页

在装有 Teamflow 的机器上运行（地址换成服务器网卡上的 IP）：

```sh
npm run demo:web -- --host 192.0.2.10 --port 3180
```

浏览器打开 `https://192.0.2.10:3180/`，用户名 `teamflow`。首次启动需要 `openssl`，自动生成带访问地址 SAN 的自签证书和随机口令，只在服务器的 `.runtime/web-access/192.0.2.10/` 保存。通过已有 SSH 连接在服务器查看口令及证书指纹：

```sh
cat .runtime/web-access/192.0.2.10/password
openssl x509 -in .runtime/web-access/192.0.2.10/cert.pem -noout -fingerprint -sha256
```

浏览器第一次访问会提示自签证书，核对指纹或配置已受信的证书。网页口令仅用于浏览器，不是模型 API key 或后端密码。所有可登录者共享该网页宿主配置的项目和权限；这不是多租户服务。限制监听网卡和允许访问的网段。

**按域名访问或监听所有网卡**：显式声明浏览器实际使用的来源。例如：

```sh
npm run demo:web -- --host 0.0.0.0 --port 8443 \
  --public-origin https://team.dev.example:8443 \
  --cert /path/fullchain.pem --key /path/privkey.pem \
  --password-file /path/teamflow-password
```

口令文件应为单行、至少 12 个字符、权限 600。`--public-origin` 是一个固定的 `协议://域名[:端口]`，并非通配名单。若使用反向代理，须保留对应 Host；不信任任意 `X-Forwarded-*`。支持 `TEAMFLOW_WEB_HOST`、`TEAMFLOW_WEB_PORT`、`TEAMFLOW_WEB_PUBLIC_ORIGIN`、`TEAMFLOW_WEB_CERT`、`TEAMFLOW_WEB_KEY`、`TEAMFLOW_WEB_PASSWORD_FILE`，命令行优先。无参数时仍为 `http://127.0.0.1:3180/`。

## 一个网页连接另一台开发机

1. 在 B 安装同版本 Teamflow 服务插件。B 项目 `opencode.json` 的插件 `options.backendId` 例如设为 `dev-b`。项目路径是 **B 上的绝对路径**。
2. 如果 B 仅支持 SSH，在**网页宿主 A** 上建立转发（跳板可写进 SSH Host 别名）：

   ```sh
   ssh -N -L 127.0.0.1:49476:127.0.0.1:49374 dev-b
   ```

   有已受信的 HTTPS 网关时，也可以直接用例如 `https://oc-b.dev.example`，不必转发；证书须对该域名有效。私有 CA 可在启动网页宿主前设置 `NODE_EXTRA_CA_CERTS`。不支持通过跨机器明文 HTTP 传输后端凭据。
3. 在 A 将下列条目加到 `.runtime/backends.json` 的 `backends`（保留原来的 `local`）：

   ```json
   "dev-b": {
     "endpoint": "http://127.0.0.1:49476",
     "projects": ["/srv/projects/example"],
     "connectionFile": ".runtime/dev-b-connection.json"
   }
   ```

   对应连接文件的格式如下；将 `password` 换成 B 的真实 OpenCode 凭据，文件权限设为 600。如走 HTTPS，两个文件中的 URL 都要换成同一个 HTTPS 地址。B 的服务插件如需 `nativeConnectionFile`，指向 **B 本机**的连接文件，不是 A 的隧道地址。

   ```json
   {"url":"http://127.0.0.1:49476","auth":{"type":"basic","username":"opencode","password":"REPLACE_ON_HOST_A"}}
   ```

4. 重启 A 的**网页宿主**，在顶部选 `dev-b` 和项目目录。界面会检查 B 返回的后端 ID 和目录；不一致时显示错误，不把操作发往另一个项目。无需重启 A 的日常 OpenCode。没有远端机器时，默认配置只有 `local`。
