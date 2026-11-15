<?php
require __DIR__ . '/../src/StatusCodeInterface.php';
require __DIR__ . '/../src/RequestMethodInterface.php';

use Fig\Http\Message\RequestMethodInterface;
use Fig\Http\Message\StatusCodeInterface;

$ok = StatusCodeInterface::STATUS_NOT_FOUND === 404
    && StatusCodeInterface::STATUS_OK === 200
    && RequestMethodInterface::METHOD_GET === 'GET';
if (!$ok) {
    fwrite(STDERR, "constants mismatch\n");
    exit(1);
}
echo "1 test, ok\n";
