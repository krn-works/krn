package project

import "testing"

func TestAddSumsTwoNumbers(t *testing.T) {
	if Add(1, 1) != 2 {
		t.Fatal("Add is broken")
	}
}
