{
  "name": "{{name}}",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "lint": "biome check .",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@biomejs/biome": "2.6.8",
    "@types/node": "24.6.2",
    "typescript": "7.0.2"
  }
}
