<?php

require __DIR__ . '/../src/StatusCodeInterface.php';
require __DIR__ . '/../src/RequestMethodInterface.php';

use Fig\Http\Message\RequestMethodInterface;
use Fig\Http\Message\StatusCodeInterface;

$checks = [
    'STATUS_OK is 200' => StatusCodeInterface::STATUS_OK === 200,
    'METHOD_GET is GET' => RequestMethodInterface::METHOD_GET === 'GET',
];

$failed = 0;
foreach ($checks as $name => $ok) {
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    $failed += $ok ? 0 : 1;
}
exit($failed === 0 ? 0 : 1);
