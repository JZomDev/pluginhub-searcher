let _cachedInstalls = null;
let _cachedVersion = null;

async function getRuneliteVersion() {
    if (_cachedVersion) {
        return _cachedVersion;
    }
    const req = await fetch("https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version");
    _cachedVersion = (await req.text()).trim();
    return _cachedVersion;
}

async function getInstallCounts(version) {
    if (_cachedInstalls) {
        return _cachedInstalls;
    }
    if (!version) {
        version = await getRuneliteVersion();
    }
    const req = await fetch(`https://api.runelite.net/runelite-${version}/pluginhub`);
    _cachedInstalls = await req.json();
    return _cachedInstalls;
}

export { getInstallCounts };
