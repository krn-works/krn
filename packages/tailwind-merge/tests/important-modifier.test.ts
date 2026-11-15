import { expect, test } from 'vitest'

import { twMerge } from '../src'

test('merges tailwind classes with important modifier correctly', () => {
    expect(twMerge('font-medium! font-bold!')).toBe('font-bold!')
    expect(twMerge('font-medium! font-bold! font-thin')).toBe('font-bold! font-thin')
    expect(twMerge('right-2! -inset-x-px!')).toBe('-inset-x-px!')
    expect(twMerge('focus:inline! focus:block!')).toBe('focus:block!')
    expect(twMerge('[--my-var:20px]! [--my-var:30px]!')).toBe('[--my-var:30px]!')

    // Tailwind CSS v3 legacy syntax

    expect(twMerge('font-medium! !font-bold')).toBe('!font-bold')

    expect(twMerge('!font-medium !font-bold')).toBe('!font-bold')
    expect(twMerge('!font-medium !font-bold font-thin')).toBe('!font-bold font-thin')
    expect(twMerge('!right-2 !-inset-x-px')).toBe('!-inset-x-px')
    expect(twMerge('focus:!inline focus:!block')).toBe('focus:!block')
    expect(twMerge('![--my-var:20px] ![--my-var:30px]')).toBe('![--my-var:30px]')
})

test('clause 1: leading important modifier with postfix modifier merges', () => {
    expect(twMerge('!text-lg/7 !text-sm')).toBe('!text-sm')
})

test('clause 2: characterizes class without leading ! or with trailing ! merging', () => {
    expect(twMerge('text-lg/7 text-sm')).toBe('text-sm')
    expect(twMerge('text-lg/7! text-sm!')).toBe('text-sm!')
})

test('clause 3: leading important modifier does not shift postfix position', () => {
    expect(twMerge('!text-lg/7 !text-sm')).toBe('!text-sm')
    expect(twMerge('!text-lg/7 !text-lg/9')).toBe('!text-lg/9')
    expect(twMerge('!text-lg/7 !text-sm/6')).toBe('!text-sm/6')
})

test('clause 4: existing behaviour is unchanged', () => {
    expect(twMerge('!font-medium !font-bold')).toBe('!font-bold')
    expect(twMerge('focus:!text-lg/7 focus:!text-sm')).toBe('focus:!text-sm')
    expect(twMerge('!text-lg/7 text-sm')).toBe('!text-lg/7 text-sm')
})

test('clause 5: postfix modifier fix covers modifiers plus leading important', () => {
    expect(twMerge('hover:!text-lg/7 hover:!text-sm/6')).toBe('hover:!text-sm/6')
})
