<?php
require_once dirname(__DIR__, 2) . '/_error_log.php';
if (!defined('REFACTORED_LEGACY_ROOT')) {
    define('REFACTORED_LEGACY_ROOT', dirname(__DIR__, 3));
}
@chdir(REFACTORED_LEGACY_ROOT);

$__rx_section = rx_compile_section(__DIR__);

try {
    if ($__rx_section['path'] !== null) {
        require $__rx_section['path'];
    } else {
        eval((string) $__rx_section['body']);
    }
} catch (Throwable $__rx_throwable) {
    $__rx_ctx = [
        'module' => basename(__DIR__),
        'class'  => get_class($__rx_throwable),
        'file'   => $__rx_throwable->getFile(),
        'line'   => $__rx_throwable->getLine(),
    ];
    if ($__rx_section['path'] !== null && $__rx_throwable->getFile() === $__rx_section['path']) {
        $__rx_src = rx_map_compiled_line(__DIR__, $__rx_throwable->getLine());
        if (is_array($__rx_src)) {
            $__rx_ctx['part'] = $__rx_src['file'];
            $__rx_ctx['part_line'] = $__rx_src['line'];
        }
    }
    rx_log_event('RX_EVAL_THROWABLE', $__rx_throwable->getMessage(), $__rx_ctx);
    throw $__rx_throwable;
}
unset($__rx_section, $__rx_throwable, $__rx_ctx, $__rx_src);
