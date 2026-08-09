# 拼豆工作室 — Pindou Studio

纯静态网页版拼豆图纸转换 & 定位辅助工具，浏览器打开即用，零依赖零构建。

**[🌐 在线使用](https://mf-tpc.github.io/pindou-studio)**

## 功能

### 🎨 图纸转换
- 图片拖拽/粘贴/上传 → 一键转为拼豆色号图纸
- **MARD 221 色**标准色板（A~H+M 系列）
- 三种颜色匹配算法可选：Median Cut（简约）/ Lab 轻度聚类（平衡） / 直接 Lab（细节多）
- **CIELAB 感知色差**匹配 + **主导色提取**，杜绝"一个颜色出多个色号"
- 符号/纯色块两种显示模式，紫色定位线

### 📍 定位辅助
- 录入实物拼豆板参数（尺寸、红线间距/偏移）
- 四色状态渲染：**黑**=板外不可用 / **白**=待拼 / **红**=已完成 / **绿**=当前批
- 按颜色分批推进，一键切换批次
- **偏远孤立点检测**——自动标注路径和距离，不用数格子
- 图纸自动居中适配板子

### 🔍 智能图纸导入
- 导入第三方拼豆软件的导出图片，自动识别网格和色号
- **颜色采样 + 轻量 OCR 双通道交叉验证**
- 图例自动解析，OCR 准确识别格内色号符号

### ✂️ 编辑 & 专注
- **左键点击**格子单格改色（移动端长按）
- **图例点击**批量替换色号（900 个一起改）
- Ctrl+Z 撤销编辑
- **拖拽裁剪**图纸，四角手柄自由调整选区
- **专注模式**（F 键）——全屏图纸 + 批次控制，双指缩放

### 📱 全平台适配
- 桌面 / 平板 / 手机三端响应式布局
- 面板可折叠，小屏默认收起
- 双指 Pinch 缩放、长按编辑
- 专注模式适配触屏

## 技术栈

纯原生 HTML + CSS + JavaScript，Canvas API 渲染，无框架无后端。

```
pindou-studio/
├── index.html
├── css/style.css
├── js/
│   ├── colormatch.js    # CIELAB 色彩转换 & 色差计算
│   ├── palettes.js      # MARD 221 色板数据
│   ├── converter.js     # 主导色提取 + Median Cut + 色号匹配
│   ├── dither.js        # Floyd-Steinberg / Ordered 抖动
│   ├── resizer.js       # 高低像素转换
│   ├── board.js         # 拼豆板参数 & 红线 & 坐标系
│   ├── importer.js      # 第三方图纸 OCR + 颜色双通道识别
│   ├── assistant.js     # 四色状态矩阵 & 批次流程 & 孤立点检测
│   ├── renderer.js      # Canvas 双模式渲染
│   ├── exporter.js      # PNG/JSON/打印导出
│   └── app.js           # 主控制器
└── .github/workflows/
    └── deploy.yml       # GitHub Pages 自动部署
```

## 本地使用

浏览器直接打开 `index.html`，或部署到任意静态服务器。

## 部署

已配置 GitHub Actions 自动部署到 GitHub Pages，push 到 master 分支即可。

## 致谢

- 色板数据来自 [HansBug/pindou-color-data](https://github.com/HansBug/pindou-color-data)
