import unittest

from app import add


class AddTest(unittest.TestCase):
    def test_add_sums_two_numbers(self) -> None:
        self.assertEqual(add(1, 1), 2)


if __name__ == '__main__':
    unittest.main()
