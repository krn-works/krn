<?php
// A minimal stand-in for the PHPUnit 4 API that an old upstream test file uses, so the held-back test
// runs unchanged on a current PHP: php phpunit-shim.php <autoload.php> <TestFile.php>.

class PHPUnit_Framework_TestCase
{
    public function assertSame($expected, $actual)
    {
        if ($expected !== $actual) {
            throw new RuntimeException('expected ' . var_export($expected, true) . ' got ' . var_export($actual, true));
        }
    }
}

[, $autoload, $file] = $argv;
require $autoload;
$before = get_declared_classes();
require $file;
$failed = 0;
$ran = 0;
foreach (array_diff(get_declared_classes(), $before) as $class) {
    if (!is_subclass_of($class, 'PHPUnit_Framework_TestCase')) {
        continue;
    }
    foreach (get_class_methods($class) as $method) {
        if (strpos($method, 'test') !== 0) {
            continue;
        }
        $doc = (new ReflectionMethod($class, $method))->getDocComment() ?: '';
        $sets = [[]];
        if (preg_match('/@dataProvider\s+(\w+)/', $doc, $m)) {
            $sets = (new $class())->{$m[1]}();
        }
        $expected = preg_match('/@expectedException\s+(\S+)/', $doc, $m) ? $m[1] : null;
        foreach ($sets as $name => $args) {
            $ran++;
            try {
                (new $class())->$method(...$args);
                $ok = $expected === null;
            } catch (Throwable $e) {
                $ok = $expected !== null && is_a($e, $expected);
            }
            if (!$ok) {
                $failed++;
                echo "FAIL $class::$method #$name\n";
            }
        }
    }
}
echo "ran $ran, failed $failed\n";
exit($ran > 0 && $failed === 0 ? 0 : 1);
