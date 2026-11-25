#!/usr/bin/env python3
"""Build the PR evidence tree: JPEG shots per stage, videos, per-stage
gallery pages and a before/final comparison page.

  gallery.py <shots_dir> <out_dir> <raw_base_url> stage:label[:scores] ...
"""
import os
import shutil
import subprocess
import sys

shots_dir, out_dir, raw_base = sys.argv[1], sys.argv[2], sys.argv[3].rstrip('/')
stages = []
for arg in sys.argv[4:]:
    parts = arg.split(':', 2)
    stages.append({'dir': parts[0], 'label': parts[1], 'scores': parts[2] if len(parts) > 2 else ''})

TITLES = {
    '01-home': 'Home', '02-home-card-hover': 'Home, card hover', '03-home-scrolled': 'Home, scrolled',
    '04-songs': 'Songs', '05-songs-row-hover': 'Songs, row hover', '06-songs-menu': 'Songs, row menu',
    '07-albums': 'Albums', '08-artists': 'Artists', '09-album-detail': 'Album',
    '10-album-detail-scrolled': 'Album, scrolled', '11-artist-detail': 'Artist', '12-favourites': 'Favourite Songs',
    '13-sources': 'Sources', '14-search': 'Search', '15-queue': 'Up Next panel', '16-lyrics': 'Lyrics panel',
    '17-now-playing': 'Now Playing', '18-settings': 'Settings', '19-settings-appearance': 'Settings, appearance',
    '20-sidebar-hidden': 'Sidebar hidden', '21-apple-home': 'Apple Music, signed out', '22-play-on-menu': 'Play on menu',
    '23-sidebar-row-hover': 'Sidebar hover', '24-search-focus': 'Search focused',
    '25-songs-menu-bottom': 'Row menu near the player', '26-empty-favourites': 'Favourites, empty',
    '30-narrow-1100-home': '1100px', '31-narrow-900-home': '900px', '32-narrow-900-songs': '900px Songs',
    '33-min-720-home': '720px (minimum)', '34-min-720-album': '720px Album', '35-narrow-1100-queue': '1100px Up Next',
    '36-wide-1920-home': '1920px', '37-narrow-900-queue': '900px Up Next', '38-narrow-900-lyrics': '900px Lyrics',
    '39-mid-1040-queue': '1040px Up Next',
    '40-worst-home': 'Worst-case names: Home', '41-worst-songs': 'Worst-case: Songs', '42-worst-album': 'Worst-case: Album',
    '43-worst-queue': 'Worst-case: Up Next', '44-worst-now-playing': 'Worst-case: Now Playing',
    '45-worst-player-900': 'Worst-case: 900px player', '46-worst-player-720': 'Worst-case: 720px player',
    '47-worst-artist': 'Worst-case: Artist',
}


def jpg(src, dst):
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-q:v', '6', dst], check=True)


def url(stage, name):
    if name.endswith('.mp4'):
        # GitHub plays videos in its blob view; the raw URL would download
        blob = raw_base.replace('https://raw.githubusercontent.com/', 'https://github.com/')
        owner, repo, *branch = blob.split('/')[3:]
        return f'https://github.com/{owner}/{repo}/blob/{"/".join(branch)}/{stage}/{name}'
    return f'{raw_base}/{stage}/{name}'


os.makedirs(out_dir, exist_ok=True)
names_by_stage = {}
for st in stages:
    src = os.path.join(shots_dir, st['dir'])
    dst = os.path.join(out_dir, st['dir'])
    os.makedirs(dst, exist_ok=True)
    names = sorted(f[:-4] for f in os.listdir(src) if f.endswith('.png'))
    names_by_stage[st['dir']] = names
    for n in names:
        jpg(os.path.join(src, n + '.png'), os.path.join(dst, n + '.jpg'))
    for v in ('walkthrough.mp4', 'motion-quarter-speed.mp4'):
        if os.path.exists(os.path.join(src, v)):
            shutil.copy(os.path.join(src, v), os.path.join(dst, v))
    for a in ('audit.txt', 'audit-worst.txt'):
        if os.path.exists(os.path.join(src, a)):
            shutil.copy(os.path.join(src, a), os.path.join(dst, a))
    lines = [f"# {st['label']}", '']
    if st['scores']:
        lines += [f"Council scores for this stage: {st['scores']}", '']
    vids = [v for v in ('walkthrough.mp4', 'motion-quarter-speed.mp4') if os.path.exists(os.path.join(dst, v))]
    if vids:
        lines += ['Videos: ' + ' · '.join(f'[{v}]({url(st["dir"], v)})' for v in vids), '']
    for n in names:
        lines += [f'### {TITLES.get(n, n)} (`{n}`)', '', f'![{n}]({url(st["dir"], n + ".jpg")})', '']
    with open(os.path.join(out_dir, f"{st['dir']}.md"), 'w') as f:
        f.write('\n'.join(lines))

first, last = stages[0]['dir'], stages[-1]['dir']
lines = [f'# Before ({stages[0]["label"]}) vs final ({stages[-1]["label"]})', '',
         '| Screen | Before | Final |', '| --- | --- | --- |']
for n in names_by_stage[last]:
    before = f'![]({url(first, n + ".jpg")})' if n in names_by_stage[first] else '(new state)'
    lines.append(f'| {TITLES.get(n, n)} | {before} | ![]({url(last, n + ".jpg")}) |')
with open(os.path.join(out_dir, 'compare.md'), 'w') as f:
    f.write('\n'.join(lines) + '\n')
print('ok', {k: len(v) for k, v in names_by_stage.items()})
