module.exports = {
    "env": {
        "browser": true,
        "es6": true
    },
    "extends": "eslint:recommended",
    "globals": {
        "Atomics": "readonly",
        "SharedArrayBuffer": "readonly"
    },
    "parserOptions": {
        "ecmaVersion": 2018,
        "sourceType": "module",
        "impliedStrict": true,
        "classes": true,
        "legacyDecorators": true
    },
    "rules": {
        "semi": [2, "always"],
        "quotes": [ "error", "single" ],
        "arrow-body-style": ["error", "never"],
        "no-debugger": "warn",
        "linebreak-style": [ "error", "unix" ],
    }
};