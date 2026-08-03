let capturedSearch: string | undefined;

export function isSub2ApiChannelLinkPath(pathname: string) {
    return pathname.toLowerCase().replace(/\/+$/, "") === "/connect/sub2api";
}

export function bootstrapSub2ApiChannelLink() {
    if (typeof window === "undefined" || !isSub2ApiChannelLinkPath(window.location.pathname)) return;
    capturedSearch = window.location.search;
    const params = new URLSearchParams(capturedSearch);
    params.delete("apiKey");
    params.delete("channel");
    const search = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`);
}

export function consumeSub2ApiChannelLinkSearch() {
    const search = capturedSearch ?? window.location.search;
    capturedSearch = undefined;
    return search;
}
