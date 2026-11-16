<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use Project\Math;

final class SmokeTest extends TestCase
{
    public function testAddSumsTwoNumbers(): void
    {
        $this->assertSame(2, Math::add(1, 1));
    }
}
