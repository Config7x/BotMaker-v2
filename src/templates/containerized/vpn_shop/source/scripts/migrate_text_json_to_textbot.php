<?php

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../re/rx/function/database_helpers_1.php';

$jsonFile = __DIR__ . '/../text.json';
if (!is_file($jsonFile)) {
    fwrite(STDERR, "text.json not found at $jsonFile\n");
    exit(1);
}

$decoded = json_decode(file_get_contents($jsonFile), true);
$fa = is_array($decoded['fa'] ?? null) ? $decoded['fa'] : [];
if (empty($fa)) {
    fwrite(STDERR, "text.json has no 'fa' content, nothing to migrate\n");
    exit(1);
}

$flat = [];
$flatten = static function (array $arr, string $prefix) use (&$flatten, &$flat) {
    foreach ($arr as $k => $v) {
        $path = $prefix === '' ? (string) $k : $prefix . '.' . $k;
        if (is_array($v)) {
            $flatten($v, $path);
        } else {
            $flat['jsontext.' . $path] = (string) $v;
        }
    }
};
$flatten($fa, '');

$inserted = 0;
$healed = 0;
$skipped = 0;

foreach ($flat as $key => $text) {
    if (strlen($key) > 600) {
        fwrite(STDERR, "SKIP (id_text exceeds 600 chars): $key\n");
        $skipped++;
        continue;
    }
    $ins = $pdo->prepare('INSERT IGNORE INTO textbot (id_text, text) VALUES (:k, :v)');
    $ins->execute([':k' => $key, ':v' => $text]);
    if ($ins->rowCount() > 0) {
        $inserted++;
        continue;
    }
    $heal = $pdo->prepare("UPDATE textbot SET text = :v WHERE id_text = :k AND (text IS NULL OR text = '')");
    $heal->execute([':v' => $text, ':k' => $key]);
    if ($heal->rowCount() > 0) {
        $healed++;
    } else {
        $skipped++;
    }
}

if (function_exists('{{BRAND_NAME}}_bust_bot_selectcache')) {
    {{BRAND_NAME}}_bust_bot_selectcache('textbot');
}
if (function_exists('clearSelectCache')) {
    clearSelectCache('textbot');
}

echo "Inserted: $inserted, Healed: $healed, Skipped(already customized or oversized): $skipped\n";
