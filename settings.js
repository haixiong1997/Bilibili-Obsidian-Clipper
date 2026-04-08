(function setupBocDefaults(globalScope) {
  const DEFAULT_SETTINGS = Object.freeze({
    noteFolder: "Clippings/Bilibili",
    obsidianApiBaseUrl: "http://127.0.0.1:27123",
    obsidianApiKey: "",
    tags: "clippings,bilibili",
    includeTimestampInBody: true,
    frontmatterFields: [
      "title",
      "url",
      "bvid",
      "cid",
      "author",
      "upload_date",
      "subtitle_lang",
      "created",
      "tags"
    ]
  });

  function cloneDefaultSettings() {
    return {
      ...DEFAULT_SETTINGS,
      frontmatterFields: [...DEFAULT_SETTINGS.frontmatterFields]
    };
  }

  globalScope.BOC_DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  globalScope.getBocDefaultSettings = cloneDefaultSettings;
})(globalThis);
