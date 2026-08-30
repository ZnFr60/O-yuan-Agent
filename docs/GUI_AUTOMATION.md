## 四、GUI 自动化工具（可选）

Conclave 的虚拟鼠标/键盘/截屏工具依赖 Python 的 pyautogui 与 Pillow。

### 安装

```bash
pip install pyautogui pillow
```

### 跨平台说明

- **Windows**：pyautogui 依赖 pywin32（通常自动安装）。
- **Linux**：需 libX11 等（sudo apt install python3-tk python3-xlib）；Wayland 下部分操作受限，建议 X11。
- **macOS**：需给终端授予辅助功能/屏幕录制权限。

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/gui/screen | 屏幕分辨率 |
| GET | /api/gui/screenshot | 截屏（返回 base64 PNG） |
| POST | /api/gui/mouse | 鼠标 move/click/scroll/drag |
| POST | /api/gui/keyboard | 键盘 type/press/hotkey/write |

> 仅完全访问权限可用于 GUI 操作；接口对无权限/中等权限返回 403。
