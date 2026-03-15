/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Returns a new function that will call the wrapped function
 * after the specified delay. If the function is called again
 * within the delay, the timer will be reset.
 * @param func The function to wrap
 * @param delay The delay in milliseconds
 */
type AnyFunction = (...args: any[]) => any;

export type DebouncedFunction<T extends AnyFunction> = T & {
    cancel(): void;
    flush(): void;
};

export function debounce<T extends AnyFunction>(func: T, delay = 300): DebouncedFunction<T> {
    let timeout: NodeJS.Timeout | null = null;
    let lastArgs: Parameters<T> | null = null;
    let lastThis: ThisParameterType<T> | undefined;

    const invoke = () => {
        if (!lastArgs) return;

        const args = lastArgs;
        const thisArg = lastThis;

        lastArgs = null;
        lastThis = undefined;

        func.apply(thisArg, args);
    };

    const debounced = function (this: ThisParameterType<T>, ...args: Parameters<T>) {
        lastArgs = args;
        lastThis = this;

        if (timeout) {
            clearTimeout(timeout);
        }

        timeout = setTimeout(() => {
            timeout = null;
            invoke();
        }, delay);
    } as DebouncedFunction<T>;

    debounced.cancel = () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }

        lastArgs = null;
        lastThis = undefined;
    };

    debounced.flush = () => {
        if (!timeout) return;

        clearTimeout(timeout);
        timeout = null;
        invoke();
    };

    return debounced;
}
