module.exports = {
    parser: '@typescript-eslint/parser', // Specifies the ESLint parser
    extends: [
        'plugin:@typescript-eslint/recommended', // Uses the recommended rules from the @typescript-eslint/eslint-plugin
    ],
    plugins: ['@typescript-eslint'],
    parserOptions: {
        ecmaVersion: 2018, // Allows for the parsing of modern ECMAScript features
        sourceType: 'module', // Allows for the use of imports
    },
    rules: {
        // Place to specify ESLint rules. Can be used to overwrite rules specified from the extended configs
        // e.g. "@typescript-eslint/explicit-function-return-type": "off",
        "no-debugger": "warn",
        "no-console": "warn",
        "prefer-const": "error",
        "no-unused-vars": [
            1,
            {
                "argsIgnorePattern": "res|next|^err"
            }
        ],
        "indent": [
            "error",
            4
        ],
        "linebreak-style": [
            "error",
            "unix"
        ],
        "brace-style": [
            "error",
            "1tbs"
        ],
        "quotes": [
            "error",
            "single"
        ],
        "@typescript-eslint/no-var-requires" : "off"
    },
    "env": {
        "browser": true,
        "node": true,
        "mongo": true,
        "es6": true,
        "jquery": true,
        "jest": true
    }
};