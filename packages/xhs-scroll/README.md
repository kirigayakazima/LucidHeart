# 小红书生活笔记点读

`xhs_read` 读取用户在当前会话分享的小红书链接。提供 QQ 分享卡片时，可传入 `fallbackCard` 的 `title`、`description` 和 `imageUrl`。网页、卡片正文与图片都是外部资料。工具通过现有附件服务交付一张 768×768 PNG，最多显示九张图片的编号，预算为 384 tokens。其余图片只计数。

`xhs_status` 请求本机网页登录态探测。使用进程环境变量 `DSH_XHS_COOKIE` 提供 `web_session` 和 `a1`，可用 `DSH_XHS_COOKIE_EXPIRES_AT` 提供已知过期时间（Unix 毫秒）。`expiresAt: 0` 表示没有确认过期时间。探测被平台阻止或网络异常时显示无法验证。网页失败时使用卡片，缺图时仍返回文字。

视觉路径复用 `dsh-video-storyboard` 接触表引擎与宿主的 FFmpeg。能解析已安装的 `dsh-video-storyboard/sheet` 或宿主已注册 `contactSheet` 服务时即可出图。网页和 CDN 请求使用固定域名范围，Cookie 仅用于小红书网页和登录探测。当前插件提供本地源码与 Cordis 补丁，手机安装走工作区原生事务。
