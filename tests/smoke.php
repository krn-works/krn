<?php
require __DIR__ . '/../src/StatusCodeInterface.php';
require __DIR__ . '/../src/RequestMethodInterface.php';

use Fig\Http\Message\RequestMethodInterface;
use Fig\Http\Message\StatusCodeInterface;

$checks = array(
    'ok' => StatusCodeInterface::STATUS_OK === 200,
    'not found' => StatusCodeInterface::STATUS_NOT_FOUND === 404,
    'get' => RequestMethodInterface::METHOD_GET === 'GET',
);
$failed = array_keys(array_filter($checks, function ($ok) { return !$ok; }));
if ($failed) {
    fwrite(STDERR, 'failed: ' . implode(', ', $failed) . "\n");
    exit(1);
}
echo count($checks) . " checks passed\n";
