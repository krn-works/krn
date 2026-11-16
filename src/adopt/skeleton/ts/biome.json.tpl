{
  "files": {
    "includes": [
      "**",
      "!package-lock.json",
      "!.agents",
      "!.claude",
      "!.krn",
      "!tasks",
      "!krn.json"
    ]
  },
  "formatter": {
    "indentStyle": "space"
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single"
    }
  },
  "linter": {
    "rules": {
      "nursery": {
        "noFloatingPromises": "error"
      }
    }
  }
}
