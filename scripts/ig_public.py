"""Read a public Instagram profile without a login.

RSS-Bridge publishes the same posts from the profile embed page. When every
bridge is empty, the sync reads that page, then Instagram's public profile
JSON. A login wall, a checkpoint, or a private account is a failed source.
No cookie is sent.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from adapters.common import BridgeError, blank_profile, clean_meta_text, post_shell

# The public web client id Instagram's own site sends. It is not a user secret.
PUBLIC_APP_ID = "936619743392459"
_HANDLE = re.compile(r"^[A-Za-z0-9._]{1,30}$")
_CONTEXT = re.compile(r'"contextJSON":"(.*)"}\]\],\["NavigationMetrics"', re.S)


def clean_handle(value: str) -> str:
    text = str(value or "").strip().lstrip("@")
    return text if _HANDLE.fullmatch(text) else ""


def profile_embed_url(handle: str) -> str:
    name = clean_handle(handle)
    if not name:
        return ""
    return "https://www.instagram.com/" + name + "/embed/"


def web_profile_url(handle: str) -> str:
    name = clean_handle(handle)
    if not name:
        return ""
    return "https://www.instagram.com/api/v1/users/web_profile_info/?username=" + name


def public_headers(url: str) -> dict:
    """Headers for Instagram's own public pages. Never a cookie."""
    text = str(url or "")
    if "instagram.com" not in text:
        return {}
    headers = {"Referer": "https://www.instagram.com/"}
    if "web_profile_info" in text:
        headers["Accept"] = "application/json"
        headers["X-IG-App-ID"] = PUBLIC_APP_ID
    return headers


def _iso(stamp) -> str:
    try:
        moment = datetime.fromtimestamp(int(stamp), timezone.utc)
    except (TypeError, ValueError, OSError, OverflowError):
        return ""
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _caption(node: dict) -> str:
    edges = ((node or {}).get("edge_media_to_caption") or {}).get("edges") or []
    if edges and isinstance(edges[0], dict):
        text = ((edges[0].get("node") or {}).get("text") or "")
        return clean_meta_text(text)
    return clean_meta_text((node or {}).get("caption") or "")


def _https(value: str) -> str:
    text = str(value or "")
    return text if text.startswith("https://") else ""


def _one_media(node: dict) -> dict | None:
    if not isinstance(node, dict):
        return None
    photo = _https(node.get("display_url") or "")
    video = _https(node.get("video_url") or "")
    dims = node.get("dimensions") or {}
    width = dims.get("width") if isinstance(dims, dict) else None
    height = dims.get("height") if isinstance(dims, dict) else None
    if node.get("is_video") and video:
        return {"type": "video", "url": video, "poster": photo, "width": width, "height": height, "alt": ""}
    if photo:
        kind = "video" if node.get("is_video") else "photo"
        item = {"type": kind, "url": photo if kind == "photo" else "", "poster": photo, "width": width, "height": height, "alt": ""}
        if kind == "photo":
            item["poster"] = photo
        return item
    return None


def _media(node: dict) -> list:
    children = ((node or {}).get("edge_sidecar_to_children") or {}).get("edges") or []
    rows = []
    if children:
        for edge in children[:4]:
            child = (edge or {}).get("node") if isinstance(edge, dict) else None
            item = _one_media(child or {})
            if item:
                rows.append(item)
        return rows
    item = _one_media(node)
    return [item] if item else []


def _permalink(node: dict) -> str:
    code = str((node or {}).get("shortcode") or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{5,40}", code):
        return ""
    kind = "reel" if str((node or {}).get("product_type") or "") in ("clips", "igtv") else "p"
    return "https://www.instagram.com/" + kind + "/" + code + "/"


def login_wall(data) -> bool:
    if not isinstance(data, dict):
        return False
    if data.get("require_login") or data.get("login_required"):
        return True
    message = str(data.get("message") or data.get("status") or data.get("error") or "").lower()
    return "login" in message or "checkpoint" in message


def _posts_from_nodes(nodes, feed: dict, profile: dict) -> list:
    posts = []
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        link = _permalink(node)
        if not link:
            continue
        code = link.rstrip("/").rsplit("/", 1)[-1]
        posts.append(
            post_shell(
                id=code,
                statusId=code,
                platform="instagram",
                feedId=feed.get("id") or "",
                kind="post",
                author=profile.get("name") or profile.get("handle") or "",
                handle=profile.get("handle") or feed.get("handle") or "",
                avatar=profile.get("avatar") or "",
                text=_caption(node),
                date=_iso(node.get("taken_at_timestamp")),
                url=link,
                media=_media(node),
            )
        )
    return posts


def _profile(user: dict, feed: dict) -> dict:
    handle = clean_handle((user or {}).get("username") or feed.get("handle") or "") or (feed.get("handle") or "")
    name = str((user or {}).get("full_name") or handle)
    avatar = _https((user or {}).get("profile_pic_url_hd") or (user or {}).get("profile_pic_url") or "")
    profile = blank_profile("instagram", handle, name, avatar)
    bio = str((user or {}).get("biography") or "").strip()
    if bio and not login_wall({"message": bio}):
        profile["bio"] = bio[:500]
    return profile


def parse_web_profile(payload, feed: dict | None = None) -> dict:
    feed = feed or {}
    if isinstance(payload, str):
        if not payload.lstrip().startswith(("{", "[")):
            raise BridgeError("instagram profile was not JSON")
        try:
            data = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise BridgeError("instagram profile was not JSON") from exc
    else:
        data = payload
    if login_wall(data):
        raise BridgeError("instagram login wall")
    user = ((data or {}).get("data") or {}).get("user") if isinstance(data, dict) else None
    if not isinstance(user, dict):
        raise BridgeError("instagram profile missing")
    profile = _profile(user, feed)
    if user.get("is_private") is True:
        return {"posts": [], "profiles": [profile]}
    edges = ((user.get("edge_owner_to_timeline_media") or {}).get("edges") or [])
    nodes = []
    for edge in edges:
        node = (edge or {}).get("node") if isinstance(edge, dict) else None
        if isinstance(node, dict):
            nodes.append(node)
    return {"posts": _posts_from_nodes(nodes, feed, profile), "profiles": [profile]}


def _unescape_embed(raw: str) -> str:
    text = str(raw or "")
    text = text.replace("\\/", "/").replace('\\"', '"').replace("\\n", "\n").replace("\\t", "\t")
    return re.sub(r"\\u([0-9A-Fa-f]{4})", lambda match: chr(int(match.group(1), 16)), text)


def parse_profile_embed(payload, feed: dict | None = None) -> dict:
    feed = feed or {}
    html = payload if isinstance(payload, str) else ""
    folded = html.lower()
    if not html or "httperrorpage" in folded or "accounts/login" in folded or "login_required" in folded:
        raise BridgeError("instagram embed unavailable")
    match = _CONTEXT.search(html)
    if not match:
        raise BridgeError("instagram embed has no posts")
    try:
        data = json.loads(_unescape_embed(match.group(1)))
    except json.JSONDecodeError as exc:
        raise BridgeError("instagram embed was not JSON") from exc
    if login_wall(data if isinstance(data, dict) else {}):
        raise BridgeError("instagram login wall")
    rows = ((data or {}).get("context") or {}).get("graphql_media") or []
    nodes = []
    for row in rows:
        media = (row or {}).get("shortcode_media") if isinstance(row, dict) else None
        if isinstance(media, dict):
            nodes.append(media)
    handle = clean_handle(feed.get("handle") or "")
    profile = blank_profile("instagram", handle, handle, "")
    return {"posts": _posts_from_nodes(nodes, feed, profile), "profiles": [profile]}
