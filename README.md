# 无限画布 — AI 节点式工作台

基于《无限画布.docx》需求文档 + 7 张交互截图实现的 **AIGC 节点流无限画布**：
暗色网格画布、双击创建节点、节点连线（类型校验）、提示词面板、模型参数、
DAG 工作流执行引擎、项目持久化、素材资产库、AI 对话助手。

## 快速运行

```bash
# 零依赖，无需 npm install（Node 18+）
node server/server.mjs
# 打开 http://localhost:3210
```

## 运行地址与运行环境

| 项目 | 说明 |
|---|---|
| **本机访问地址** | **http://localhost:3210** （启动后浏览器直接打开） |
| 自定义端口 | `PORT=8080 node server/server.mjs` → http://localhost:8080 |
| 局域网访问 | 同一局域网其他设备访问 `http://<本机IP>:3210`（如 http://192.168.x.x:3210） |
| 运行时环境 | **Node.js ≥ 18**（本项目开发验证环境：Node 22.22.2），后端与静态服务均为 Node 原生能力 |
| 前端环境 | 原生 JavaScript ES Module + CSS，**无框架、无构建步骤**，任何现代 Chromium 内核浏览器（Chrome / Edge）直接运行 |
| 第三方依赖 | **零 npm 依赖**——后端用 `node:http` / `node:fs`，前端无框架，无需 `npm install` |
| 数据存储 | 本地文件模拟：项目画布 JSON → `server/data/projects/`；素材文件 → `server/data/assets/`（生产环境替换为 MySQL/PostgreSQL + 对象存储 OSS/S3/COS） |
| 实时通信 | SSE（`EventSource`，Node 原生 HTTP 分块响应）；生产可换 WebSocket |
| AI 推理 | 当前为内置 Mock 适配器（`server/aiAdapter/`），无外部模型服务依赖；接入真实模型时替换为对推理服务的 HTTP 调用 |

### 已配置的模型清单（Mock 适配，可直接切换真实 API）

| 类型 | 模型 | 积分 | 参数范围 |
|---|---|---|---|
| 图片 | 图片 5.0 Lite / 图片 5.0 Pro | 3 / 8 | 比例 1:1·3:4·4:3·16:9·9:16，分辨率 1K/2K/4K |
| 图片 | **Nano Banana Pro** | 10 | 同上 |
| 图片 | **GPT Image 2.0** | 12 | 同上 |
| 视频 | 即梦 Seedance 2.0 / 2.0 VIP | 56 / 120 | 分辨率 480P/720P/1080P，**时长 4–15 秒** |
| 视频 | **即梦 Seedance 2.5** | 90 | 分辨率 480P/720P/1080P，**时长 4–30 秒** |
| 音频 | 语音合成 TTS v2 | 2 | 时长 2/3/5/10 秒 |
| 文本 | 文本模型 Lite | 1 | — |

> 视频时长同时提供**滑动条 + 数字输入**两种方式，切换模型时自动钳制到该模型的时长范围。

## 功能清单（与需求文档一级/二级功能对照）

### 一级 1：画布基础空间引擎
| 功能 | 实现 |
|---|---|
| 画布平移（拖拽空白）/ 中键 / Alt+拖拽 | `canvas/interaction.js` |
| 滚轮缩放（以鼠标为锚点，0.15x–3x） | `canvas/camera.js` |
| 屏幕坐标 ↔ 世界坐标转换 | `canvas/camera.js` |
| 点阵网格背景（仅渲染视口内） | `canvas/gridRenderer.js` |
| 小地图预览 + 点击定位 | `canvas/minimap.js` |
| 节点增删 / 拖拽移动 / 选中 / 多选 / Shift 框选 | `canvas/interaction.js` + `store.js` |
| 撤销 / 重做（Ctrl+Z / Ctrl+Shift+Z）、复制粘贴（Ctrl+C/V/D） | `store.js` 快照历史 |
| 双击画布唤起新建节点菜单、右键菜单、快捷键体系 | `canvas/interaction.js` |

### 一级 2：节点组件体系（7 类节点 + 素材节点）
- **文本**：提示词输入 + LLM 扩写
- **图片**：提示词生成、上传参考图（上传/资产库/从画布选择三入口，对应截图 5）、模型（图片 5.0 Lite/Pro）、比例/分辨率/张数参数
- **视频**：图生视频、@引用参考、即梦 Seedance 2.0 / VIP 模型、16:9/720P/时长/全能参考（对应截图 7）
- **音频**：TTS / 音效（Mock 生成真实 WAV）
- **时间线**：上游视频/图片时序编排
- **主体**：角色资产固化，跨节点复用
- **导演台**：全局分镜调度
- 底部提示词面板：上传参考图、@ 按钮、积分显示（✦3/张、✦56）、生成按钮（对应截图 3）

### 一级 3：AI 工作流执行引擎
- **连线**：端口拖拽连线、蓝色贝塞尔曲线渲染、点击连线删除
- **类型校验**：图片输出只能连到接受的输入（图片→视频 ✓，图片→文本 ✗），前后端双重校验
- **拖线到空白** → 弹出「添加节点」菜单（兼容类型高亮），创建后自动连线（对应截图 6）
- **@引用解析**：提示词中 `@图片1` 自动建立连线（`dag/graph.js`）
- **DAG**：前端 Kahn 拓扑排序 + 环检测预校验；后端二次校验防篡改
- **任务调度**：按拓扑序逐节点执行 → 进度回调 → SSE 推送节点状态（待执行/生成中/完成/失败）→ 节点回写资源预览
- 支持整图运行（▶ 运行 / Ctrl+Enter）和单节点运行（面板生成按钮，自动收集上游子图）

### 一级 4：项目与资源资产系统
- 项目新建 / 保存 / 加载 / 列表（顶栏「项目 ▾」），画布 JSON 持久化到 `server/data/projects/`
- 素材上传（本地上传 → base64 → 服务端存储）、资产库面板、生成结果自动入库
- 积分额度校验：余额不足拒绝执行（HTTP 402），执行后扣减并在顶栏实时显示

### 一级 5：AI 对话辅助（右下角）
- 支持：`创建一个图片节点`、`连接图片1到视频1`、`把图片1的提示词改成 xxx`、`运行`、`保存`、`清空画布`
- 本地规则引擎实现，接入点在 `aiChat/chat.js` 的 `interpret()`，可替换为 LLM + function calling

## 目录结构（与文档「代码目录分层」对应）

```
D:\wuxianhuabu
├── start.bat                  # Windows 一键启动（双击运行）
├── server/                    # 后端（Node 零依赖）
│   ├── server.mjs             # 入口：静态托管 + REST + SSE
│   ├── api/                   # projects / assets / tasks 控制器
│   ├── config/                # keys.json API Key 配置（仅服务端本地，页面不显示）
│   ├── dagEngine/topo.js      # 拓扑排序(Kahn) + 环检测 + 端口规则
│   ├── scheduler/             # 事件总线 + 工作流任务队列
│   ├── aiAdapter/             # AI 模型适配层（Mock：SVG图片/动画视频预览/WAV音频/LLM文本）
│   ├── db/projects.js         # 项目 JSON 持久化（对应数据库项目表）
│   ├── storage/assets.js      # 素材存储（模拟对象存储 OSS）
│   └── data/                  # projects/ + assets/ 运行时数据
├── frontend/
│   ├── index.html
│   ├── styles/                # main / nodes / panels（暗色主题，还原截图 UI）
│   └── js/
│       ├── main.js            # 入口：工具栏/菜单/运行/SSE/项目系统
│       ├── store.js           # 全局状态 + 撤销重做
│       ├── canvas/            # camera / gridRenderer / minimap / interaction / edge/
│       ├── nodes/             # nodeRegistry（类型定义）+ nodeDom（渲染与面板）
│       ├── dag/graph.js       # 拓扑排序 / @引用解析 / 图校验 / 子图收集
│       ├── services/api.js    # HTTP + SSE + 上传
│       └── aiChat/chat.js     # AI 对话指令解释器
└── package.json
```

## 数据流（对应文档「四、数据流完整示例」）

1. 双击画布 → 创建图片节点 → 输入提示词 → 选模型 → 点击生成
2. 前端收集子图提交 `/api/tasks/run` → 后端拓扑排序 → 按序投递任务
3. 图片生成完成 → 资源 ID 回写节点 outputs → SSE 推送前端渲染预览
4. 拖拽图片输出端口连线到视频节点（或提示词 `@图片1` 自动连线）
5. 视频节点运行 → 后端拿到上游图片资源 → 调用视频推理（Mock）→ 推送结果

## 接入真实 AI 模型

所有 Mock 生成集中在 `server/aiAdapter/index.js` 的 `runNodeTask()`，
将其中的 SVG/WAV 生成分支替换为对独立推理服务（image-infer / seedance-infer /
llm-service / audio-service）的 HTTP 调用即可，前端无需改动。

## Seedance 2.5 视频接口接入（火山方舟 Ark）

在 `server/config/keys.json` 填入 `"jimeng": "<方舟 API Key>"` 后，视频节点走真实
Seedance 任务通道（`server/aiAdapter/arkVideo.js`），未填 Key 自动回落 mock。

**视频节点四种任务模式**（节点面板模式选择器）：

| 模式 | 方舟 omni_reference_task_type | 模型 | 参数特点 |
|---|---|---|---|
| 文生视频 | （普通 tasks 接口） | doubao-seedance-1-0-pro-250528 | ratio/时长/watermark=false |
| 全能参考 | `reference` | doubao-seedance-2-5-260628 | 上游图片→`reference_image`、上游视频→`reference_video`，generate_audio=true |
| 编辑视频 | `edit` | doubao-seedance-2-5-260628 | ratio=adaptive、duration=-1 |
| 延长视频 | `extend` | doubao-seedance-2-5-260628 | ratio=adaptive、duration=延长后总时长；第一个视频参考为被延长的源 |

**任务生命周期**：
- 创建 `POST /contents/generations/tasks` → 节点显示**生成中**并带任务 ID（悬停状态徽标可见）
- 轮询 `GET /contents/generations/tasks/<id>`（10 秒间隔，上限 30 分钟），未成功一律显示**生成中**并推进度
- **节点级取消**：生成中的节点标题栏出现红色 **✕**，点击后调 `DELETE /contents/generations/tasks/<id>`，节点显示**已取消**（服务端接口：`POST /api/tasks/cancel-node`）
- 生成成功 → 视频自动下载到 **`server/data/videos/` 专用文件夹**，节点卡片内直接播放，可下载 `.mp4/.mov`

**视频文件管理**：
- `GET /api/videos` 视频清单（任务 ID/模型/模式/时长/大小）
- `DELETE /api/videos/<id>` 删除视频（文件+清单+素材库同步清理）
- 视频同时注册进画布**资产库**，可被其他节点 @引用/连线；服务重启后自动恢复注册
- `GET /api/videos/file/<文件名>` 视频文件流（支持 mp4/mov/webm）

## 即梦图片4.0/4.6 接口接入（火山引擎视觉服务）

在 `server/config/keys.json` 填入 `"volcAccessKey"` / `"volcSecretKey"`（火山引擎「密钥管理」的
AK/SK，与方舟 API Key 是两套凭证）后，**图片节点优先走即梦真实通道**（`server/aiAdapter/jimengImage.js`）。
图片节点面板的模型选择器可直接切换：**即梦图片4.6**（`jimeng_seedream46_cvtob`，默认）与
**即梦图片4.0**（`jimeng_t2i_v40`）；`jimeng46ReqKey` / `jimengImageReqKey` 可覆盖服务标识。

- 接口：`https://visual.volcengineapi.com`，`Action=CVSync2AsyncSubmitTask` 提交 +
  `CVSync2AsyncGetResult` 轮询（3 秒间隔，上限 10 分钟），`req_key=jimeng_t2i_v40`
- 鉴权：火山引擎 V4 HMAC-SHA256 请求签名（Node crypto 实现，已与官方 Python demo 逐字节对拍）
- 参考图：手动上传/连线上游的 PNG/JPG/BMP/WebP 自动 base64 进 `binary_data_base64`（最多 10 张，
  SVG 占位自动跳过）；比例映射 1:1→2048²、16:9→2560×1440、9:16→1440×2560、3:4→1776×2368、4:3→2368×1776
- `force_single=true` 强制单图；生成成功自动落盘资产库，节点卡片显示图片、可下载 png/jpg
- 节点级取消：生成中点标题栏 ✕ 停止轮询；调用失败自动回落 mock，未配 AK/SK 走原通道

## 操作速查

| 操作 | 方式 |
|---|---|
| 创建节点 | 双击画布 / 左侧工具栏 / 拖线到空白 / **Tab**（画布中心） |
| 平移 / 缩放 | **Ctrl+左键拖动**（或中键/Alt+拖/**Space+拖**）/ 滚轮 / **Ctrl+加号、Ctrl+减号** |
| 适应画布 | **Ctrl+0**（自动缩放并居中到全部节点） |
| 框选 / 多选 | 左键拖拽空白（Shift=加选）/ Ctrl 或 Shift+点击 |
| 连线 | 拖拽节点左右侧「＋」端口；点击连线删除；**Ctrl+L**（若被浏览器占用则选中节点后直接按 **L**）按顺序批量连线 |
| 连线类型 | 图片→图片/视频/主体；视频→视频/时间线；**音频→视频/音频/导演台**；素材节点按实际内容类型校验。**视频模型参考上限**：即梦视频2.0（含VIP）图片≤9张、音频≤3个且总时长≤15秒；即梦视频2.5图片≤50张、音频总时长≤60秒——超限拒绝连线并弹失败提示（@引用自动连线同样受限；切换模型时超限会提示） |
| 成组 / 解组 | **Ctrl+G** / **Ctrl+Shift+G**；组框可整组选中/拖动，**双击组名重命名**，右键组框可重命名/重置大小/解组；**拖拽组框右/下边缘或右下角手柄可调节组框大小** |
| 复制节点和连线 | **Ctrl+D** 原地复制：副本与原节点一模一样（提示词/@引用/参考图/生成结果全保留），仅名字加「副本」并自动编号，位置贴着原节点错开，上游连线一并接回，副本自动选中弹面板；**Ctrl+C → Ctrl+V** 粘贴节点副本（不会把剪贴板里的截图误传成素材）；**Alt+拖动节点** 直接拖出副本 |
| 整理画布 | **Alt+Shift+F**（按依赖关系自动分层布局） |
| 粘贴/拖放上传 | 复制图片后 **Ctrl+V** 粘贴上传（复制的是节点时 Ctrl+V 粘贴节点副本）、把图片/音频/视频文件拖进画布，自动上传建素材节点并连线 |

## 日志系统

服务端自动写两类日志（按天分文件，位于 `server/data/logs/`）：

| 文件 | 内容 |
|---|---|
| `info-YYYY-MM-DD.log` | **运行日志**：服务启动、每个 API 请求（方法/路径/状态码/耗时）、未捕获异常 |
| `operation-YYYY-MM-DD.log` | **操作日志**：创建节点、建立连线、上传素材、运行工作流（含节点类型统计与积分消耗）、成组/解组、项目保存等前端与服务端操作 |

- 页面上做的每一步操作都会实时记录（前端通过 `/api/logs/client` 上报），方便回溯"做了什么"
- 也可通过接口读取最近日志：`GET /api/logs?type=info|operation&lines=200`

| 节点搜索 | **Ctrl+F**（按名称/提示词搜索，回车定位） |
| 工具切换 | **V** 移动工具 / **H** 抓手工具 |
| 重命名节点 | **双击节点标题栏的名字**（改名后 @引用、下载文件名自动同步） |
| 下载结果 | 节点标题栏 **⬇** 按钮（文件名=节点名；**图片一律下载为 .png，视频一律 .mp4**——模拟视频的 SVG 占位动画会自动转码，浏览器不支持 MP4 编码时回退 .webm；音频/文本按实际格式） |
| 运行整图 / 单节点 | ▶ 运行（Ctrl+Enter）/ 面板生成按钮 |
| 撤销 / 重做 | Ctrl+Z / Ctrl+Shift+Z |
| 删除 | Del / Backspace |
| 保存 / 项目列表 | Ctrl+S / 顶栏「项目 ▾」 |
| 快捷键帮助 | 底部工具栏 **？** 按钮 |
