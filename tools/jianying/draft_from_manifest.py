#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PathB 试验: 用 pyJianYingDraft 把"场景图+配音+字幕"生成一个剪映草稿工程。
  你在 Mac 剪映里打开该草稿(目录页可能需进退一次刷新), 即可看到时间轴, 手动导出对比质量。
用法: python3 draft_from_manifest.py manifest.json
依赖: pip install pyJianYingDraft   (Mac 草稿生成 OK; 导出需在剪映里手动点)
说明: 转场/入场动画用了剪映自带效果(叠化/渐显/打字机); 草稿格式生成支持剪映5+。
"""
import sys, json
import pyJianYingDraft as draft
from pyJianYingDraft import trange, TrackType, IntroType, TransitionType, TextIntro, TextStyle, ClipSettings

def build(manifest_path: str):
    cfg = json.load(open(manifest_path, encoding="utf-8"))
    W = int(cfg.get("width", 1080)); H = int(cfg.get("height", 1920)); fps = int(cfg.get("fps", 30))
    folder = draft.DraftFolder(cfg["draftsFolder"])
    script = folder.create_draft(cfg.get("name", "bossmate-sample"), W, H, fps=fps, allow_replace=True)
    script.add_track(TrackType.video)
    script.add_track(TrackType.text)
    script.add_track(TrackType.audio)

    cursor = 0.0
    for i, sc in enumerate(cfg["scenes"]):
        dur = float(sc["durationSec"])
        seg = draft.VideoSegment(sc["image"], trange(f"{cursor}s", f"{dur}s"))
        seg.add_animation(IntroType.渐显)                  # 入场: 渐显(柔和)
        if i > 0:
            seg.add_transition(TransitionType.叠化)        # 段间转场: 叠化
        script.add_segment(seg)

        if sc.get("subtitle"):
            ts = draft.TextSegment(
                sc["subtitle"], trange(f"{cursor}s", f"{dur}s"),
                style=TextStyle(size=8.0, color=(1.0, 1.0, 1.0), auto_wrapping=True, max_line_width=0.82),
                clip_settings=ClipSettings(transform_y=-0.72),  # 字幕放下方
            )
            ts.add_animation(TextIntro.打字机_I)            # 字幕: 打字机入场
            script.add_segment(ts)
        cursor += dur

    if cfg.get("audio"):
        script.add_segment(draft.AudioSegment(cfg["audio"], trange("0s", f"{cursor}s")))

    script.save()
    print(f"✅ 剪映草稿已生成: {cfg.get('name')}  (总时长 {cursor}s)")
    print(f"   去剪映目录页找到「{cfg.get('name')}」打开 → 手动导出。")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python3 draft_from_manifest.py manifest.json"); sys.exit(1)
    build(sys.argv[1])
