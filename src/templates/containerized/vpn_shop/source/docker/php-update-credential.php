<?php

$rootDirectory   = dirname(__DIR__) . '/';
$configDirectory = $rootDirectory . 'config.php';

if (!is_file($configDirectory)) {
    fwrite(STDERR, "[php-update-credential] config.php not found at {$configDirectory}\n");
    exit(1);
}

$operation = $argv[1] ?? '';
$variable  = $operation === 'read' ? ($argv[2] ?? '') : $operation;
$value     = $operation === 'read' ? '' : ($argv[2] ?? '');

if (!in_array($variable, ['usernamedb', 'passworddb'], true)) {
    fwrite(STDERR, "[php-update-credential] invalid target variable: {$variable}\n");
    exit(1);
}

function formatConfigValue($value, $quoteChar = '\'')
{
    if ($quoteChar !== "'" && $quoteChar !== '"') {
        $quoteChar = "'";
    }
    $stringValue  = (string) $value;
    $escapedValue = addcslashes($stringValue, "\\$quoteChar");
    return $quoteChar . $escapedValue . $quoteChar;
}

$rawConfigData    = file_get_contents($configDirectory);
$replacementCount = 0;

$pattern = '/(\$' . preg_quote($variable, '/') . '\s*=\s*)([\'\"])(.*?)(\2)(\s*;)([^\n]*)(\n?)/u';
if ($operation === 'read') {
    if (!preg_match($pattern, $rawConfigData, $matches)) {
        exit(1);
    }
    echo stripcslashes($matches[3]);
    exit(0);
}

$updatedConfig = preg_replace_callback(
    $pattern,
    function ($matches) use ($value, &$replacementCount) {
        $replacementCount++;
        $quoteChar      = $matches[2];
        $formattedValue = formatConfigValue($value, $quoteChar);
        return $matches[1] . $formattedValue . $matches[5] . $matches[6] . $matches[7];
    },
    $rawConfigData,
    1
);

if ($replacementCount === 0 || file_put_contents($configDirectory, $updatedConfig) === false) {
    fwrite(STDERR, "[php-update-credential] failed to rewrite config.php (replacementCount={$replacementCount})\n");
    exit(1);
}

echo "[php-update-credential] config.php updated ({$variable}).\n";
