"""Where a public Instagram or Threads timeline is read from.

The sync tries the local RSSHub and RSS-Bridge containers first, then public
mirrors. Nothing here is an account handle.
"""

from __future__ import annotations


def rsshub_bases() -> tuple:
    return (
        "{rsshubBase}",
        "https://rsshub.app",
        "https://rsshub.pseudoyu.com",
        "https://rsshub.rss.tips",
    )


def instagram_rss_urls() -> list:
    return [base.rstrip("/") + "/instagram/user/{handle}" for base in rsshub_bases()]


def threads_rss_urls() -> list:
    return [base.rstrip("/") + "/threads/{handle}" for base in rsshub_bases()]


def instagram_bridge_urls() -> list:
    return [
        "http://localhost:8080/?action=display&bridge=InstagramBridge&context=Username&u={handle}&format=Atom",
        "https://rss-bridge.org/bridge01/?action=display&bridge=InstagramBridge&context=Username&u={handle}&format=Atom",
        "https://rss-bridge.ggc-project.de/?action=display&bridge=InstagramBridge&context=Username&u={handle}&format=Atom",
    ]


def instagram_public_urls() -> list:
    """Public pages Instagram itself serves. No cookie. Tried after the bridges."""
    return [
        "https://www.instagram.com/{handle}/embed/",
        "https://www.instagram.com/api/v1/users/web_profile_info/?username={handle}",
    ]


def threads_bridge_urls() -> list:
    return [
        "http://localhost:8080/?action=display&bridge=ThreadsBridge&context=Username&u={handle}&format=Atom",
        "https://rss-bridge.org/bridge01/?action=display&bridge=ThreadsBridge&context=Username&u={handle}&format=Atom",
    ]


def feed_urls(platform: str) -> list:
    if platform == "instagram":
        return instagram_rss_urls() + instagram_bridge_urls() + instagram_public_urls()
    if platform == "threads":
        return threads_rss_urls() + threads_bridge_urls()
    return []
