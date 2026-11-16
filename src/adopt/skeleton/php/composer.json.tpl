{
  "name": "project/{{name}}",
  "autoload": {
    "psr-4": {
      "Project\\": "src/"
    }
  },
  "require-dev": {
    "phpunit/phpunit": "^11",
    "phpstan/phpstan": "^2"
  },
  "scripts": {
    "test": "vendor/bin/phpunit",
    "lint": "find src tests -name '*.php' -print0 | xargs -0 -n1 php -l",
    "typecheck": "vendor/bin/phpstan analyse --no-progress"
  }
}
