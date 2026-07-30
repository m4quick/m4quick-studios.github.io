#!/usr/bin/env python3
"""Static buttons-and-links check for the M4Quick Studios site.
Fails (exit 1) on any dead in-page anchor, missing relative page, or action-less form.
External URLs are checked separately (lychee). No network needed here."""
import sys, re, os, glob

HTML_FILES = sorted(glob.glob("*.html"))
ROOT_INDEX = "index.html"

def ids_of(path):
    return set(re.findall(r'id="([^"]+)"', open(path, encoding="utf-8").read()))

page_ids = {f: ids_of(f) for f in HTML_FILES}
root_ids = ids_of(ROOT_INDEX) if os.path.exists(ROOT_INDEX) else set()
fails, checked, external = [], 0, set()

for f in HTML_FILES:
    h = open(f, encoding="utf-8").read()
    for href in re.findall(r'href="([^"]+)"', h):
        checked += 1
        if href == "#":
            continue
        if href.startswith("#"):
            if href[1:] not in page_ids[f]:
                fails.append(f"{f}: dead in-page anchor {href}")
        elif href.startswith("mailto:"):
            if "@" not in href:
                fails.append(f"{f}: malformed mailto {href}")
        elif href.startswith(("http://", "https://")):
            external.add(href)
        elif href.startswith("/#"):
            if href[2:] not in root_ids:
                fails.append(f"{f}: root anchor {href} not found in index.html")
        elif href.startswith("/"):
            target = href[1:].split("#")[0]
            if target and not os.path.exists(target):
                fails.append(f"{f}: root path {href} -> missing file {target}")
        else:
            target = href.split("#")[0]
            if target and not os.path.exists(target):
                fails.append(f"{f}: relative link {href} -> missing file {target}")
    for form in re.findall(r"<form[^>]*>", h):
        if "action=" not in form:
            fails.append(f"{f}: <form> has no action")

print(f"Checked {checked} links across {len(HTML_FILES)} page(s): {', '.join(HTML_FILES)}")
print(f"External URLs (verified by lychee step): {len(external)}")
if fails:
    print("\nFAILURES:")
    for x in fails:
        print("  -", x)
    sys.exit(1)
print("PASS: all in-page anchors resolve, all relative pages exist, all forms have actions.")
