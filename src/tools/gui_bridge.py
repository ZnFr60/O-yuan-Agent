#!/usr/bin/env python3
# gui_bridge.py - Conclave GUI 自动化桥接 (跨平台: Windows/Linux/macOS)
# 依赖: pyautogui, PIL(Pillow)
# 用法: python gui_bridge.py <cmd> [json_args]
#   cmd: screenshot | screencrop | mouse | keyboard | screen | locate
import sys, json, os, base64, io

def import_deps():
    try:
        import pyautogui
        from PIL import Image
        pyautogui.PAUSE = 0.05
        # FailSafe：GUI Agent 需要能操作屏幕角落（如点关闭按钮），且本桥接受三级权限管控，
        # 因此默认关闭 pyautogui 的角落紧急停止；如需启用可设环境变量 OYUAN_GUI_FAILSAFE=1
        pyautogui.FAILSAFE = os.environ.get('OYUAN_GUI_FAILSAFE', '0') == '1'
        return pyautogui, Image
    except Exception as e:
        sys.stderr.write("MISSING_DEPS: " + str(e) + "\n")
        sys.exit(2)

def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "help"
    args = {}
    if len(sys.argv) > 2:
        try:
            args = json.loads(sys.argv[2])
        except Exception:
            args = {}

    if mode == "help":
        out({"cmds": ["screen", "screenshot", "screencrop", "mouse", "keyboard", "locate"]})
        return

    pyautogui, Image = import_deps()

    if mode == "screen":
        w, h = pyautogui.size()
        out({"width": w, "height": h})
        return

    if mode == "screenshot":
        img = pyautogui.screenshot()
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        out({"ok": True, "width": img.width, "height": img.height, "png_base64": base64.b64encode(buf.getvalue()).decode("ascii")})
        return

    if mode == "screencrop":
        region = args.get("region") or [0, 0, 800, 600]
        img = pyautogui.screenshot(region=tuple(region))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        out({"ok": True, "width": img.width, "height": img.height, "png_base64": base64.b64encode(buf.getvalue()).decode("ascii")})
        return

    if mode == "mouse":
        action = args.get("action") or "move"
        if action == "move":
            x, y = int(args.get("x", 0)), int(args.get("y", 0))
            dur = float(args.get("duration", 0.2))
            pyautogui.moveTo(x, y, duration=dur)
        elif action == "click":
            x, y = args.get("x"), args.get("y")
            if x is not None and y is not None:
                pyautogui.moveTo(int(x), int(y), duration=0.1)
            btn = args.get("button", "left")
            clicks = int(args.get("clicks", 1))
            pyautogui.click(clicks=clicks, button=btn)
        elif action == "doubleClick":
            pyautogui.doubleClick()
        elif action == "rightClick":
            pyautogui.rightClick()
        elif action == "scroll":
            pyautogui.scroll(int(args.get("amount", 3)))
        elif action == "drag":
            dx, dy = int(args.get("x", 0)), int(args.get("y", 0))
            dur = float(args.get("duration", 0.5))
            pyautogui.dragRel(dx, dy, duration=dur)
        elif action == "position":
            out({"ok": True, "x": pyautogui.position()[0], "y": pyautogui.position()[1]})
            return
        out({"ok": True})
        return

    if mode == "keyboard":
        action = args.get("action", "type")
        if action == "type":
            text = str(args.get("text", ""))
            interval = float(args.get("interval", 0.02))
            pyautogui.typewrite(text, interval=interval)
        elif action == "press":
            keys = args.get("keys") or []
            for k in keys:
                pyautogui.press(k)
        elif action == "hotkey":
            combo = str(args.get("combo", ""))
            pyautogui.hotkey(*combo.split("+"))
        elif action == "write":  # 支持中文/Unicode (typewrite 不支持中文)
            text = str(args.get("text", ""))
            pyautogui.write(text, interval=float(args.get("interval", 0.02)))
        out({"ok": True})
        return

    if mode == "locate":
        # 在屏幕上查找图片位置 (需提供 image 文件路径)
        target = args.get("image")
        if not target:
            out({"ok": False, "error": "image required"})
            return
        confidence = float(args.get("confidence", 0.8))
        try:
            box = pyautogui.locateOnScreen(target, confidence=confidence)
            if box:
                center = pyautogui.center(box)
                out({"ok": True, "left": box.left, "top": box.top, "width": box.width, "height": box.height,
                     "cx": center.x, "cy": center.y})
            else:
                out({"ok": False, "found": False})
        except Exception as e:
            out({"ok": False, "error": str(e)})
        return

    out({"ok": False, "error": "unknown cmd: " + mode})

if __name__ == "__main__":
    main()
