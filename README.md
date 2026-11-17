# 行为特征分析与事件溯源平台

面向用户行为打点采集、事件参数规范、会话重放、热力图分析、特征工程提取与行为标签体系管理的本地化数据分析应用平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 事件规范 | `eventspec` | 事件定义 | 事件编号、事件名称、事件类别 |
| 会话重放 | `session` | 会话记录 | 会话编号、用户标识、开始时间 |
| 热力分析 | `heatmap` | 热力方案 | 方案编号、目标页面、点击热力图 |
| 特征工程 | `feature` | 特征模板 | 模板编号、特征名称、特征类型 |
| 行动标签 | `action` | 标签规则 | 规则编号、标签名称、标签类别 |
| 路径分析 | `pathmap` | 路径模型 | 模型编号、起始页面、终止页面 |
| 事件溯源 | `eventtrace` | 事件链路 | 链路编号、事件链序列、链长度 |
| 时段分析 | `timewindow` | 时段配置 | 配置编号、时段名称、起始时分 |
| 设备分析 | `device` | 设备画像 | 画像编号、设备类型、操作系统 |
| 异常检测 | `anomaly` | 检测器 | 检测器编号、监控事件、异常模式 |
| 异常标签复核 | `review` | 复核项（领域模块，无独立登记页数据，入口见下） | 异常对象、误报计数、误报来源 |
| 群组对比 | `cohortcmp` | 对比任务 | 任务编号、群组A、群组B |
| 漏斗诊断 | `funnel` | 诊断报告 | 报告编号、漏斗名称、步骤定义 |
| 浏览深度 | `scrollmap` | 深度分析 | 分析编号、页面名称、首屏占比 |
| 表单分析 | `formfield` | 表单诊断 | 诊断编号、表单名称、总字段数 |
| 点击流 | `clickstream` | 点击序列 | 序列编号、用户标识、起始时间 |
| 回访分析 | `retention` | 回访模式 | 模式编号、用户分群、首次访问窗口 |
| 数据视图 | `dataview` | 分析视图 | 视图编号、视图名称、数据源组合 |
| 参数字典 | `paramdef` | 参数定义 | 参数编号、参数名称、参数类型 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `behavior-event-trace-hub:entries` 这一项，或调用 `resetModule(模块)`。

## 异常标签复核（误报收敛）

「异常标签复核」页（路由 `/review`）围绕标签异常联动，落在 `frontend/src/domain/review/`：

- 调用链：行动标签规则（`action`，仅「已生效」规则产出命中）→ 异常标签命中结果 → 异常检测
  （`anomaly`，高/低敏检测器 + 检测窗口）→ 误报收敛 → 异常标签待复核数据清单。
- 收敛不变量（`convergence.ts` 纯函数，可按增量结果反复复算）：
  - 每个异常对象在当前复核清单只占一个复核位置（按 `objectKey` 去重）。
  - 两个重叠检测窗口同时汇总时复核项只增加一次；后到结果只补充可展开来源，误报计数不重复增加。
  - 高敏检测结果与低敏历史命中在同一异常对象重叠时触发版本冲突仲裁，支持
    检测窗口归并（窗口级误报收敛清单）与标签规则归并（规则级异常来源清单）两种仲裁轴。
  - 增量复算基于上一版完整快照局部合并，未受影响规则继续读取上一完整异常标签命中结果。
- 并发写入（`review-store.ts`）：`runExclusive` 互斥链 + 版本号乐观校验，并发请求只落盘一份清单，
  另一份回执 `CONFLICT`，不会重放为新增。复核清单持久化键：
  `behavior-event-trace-hub:anomaly-review`。
- 测试（无新增依赖，esbuild 打包后在 Node 运行，带 localStorage 内存桩）：

  ```bash
  cd frontend
  npm test          # 领域引擎 48 项 + 服务链路 22 项
  ```

领域：数据工程
子方向：数据分析与数据应用
