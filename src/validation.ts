import { isRecord, isUnknownArray } from "./collections.js";

export type Validator<T> = (value: unknown) => value is T;
type Fields = Record<string, Validator<unknown>>;
type Validated<S extends Fields> = { [K in keyof S]: S[K] extends Validator<infer T> ? T : never } & Record<string, unknown>;

export const string: Validator<string> = (value): value is string => typeof value === "string";
export const nonempty: Validator<string> = (value): value is string => string(value) && value.trim().length > 0;
export const boolean: Validator<boolean> = (value): value is boolean => typeof value === "boolean";
export const finite: Validator<number> = (value): value is number => typeof value === "number" && Number.isFinite(value);
export const nonnegative: Validator<number> = (value): value is number => finite(value) && value >= 0;
export const integer: Validator<number> = (value): value is number => Number.isSafeInteger(value);
export const count: Validator<number> = (value): value is number => integer(value) && value >= 0;
export const positiveInteger: Validator<number> = (value): value is number => integer(value) && value > 0;

/** Open object shapes: validate declared fields without discarding producer extensions. */
export function shape<S extends Fields>(fields: S): Validator<Validated<S>> {
  return (value): value is Validated<S> => isRecord(value) && Object.entries(fields).every(([key, validate]) => validate(value[key]));
}
export function arrayOf<T>(validate: Validator<T>): Validator<T[]> {
  return (value): value is T[] => isUnknownArray(value) && value.every(validate);
}
export function nullable<T>(validate: Validator<T>): Validator<T | null> {
  return (value): value is T | null => value === null || validate(value);
}
export function optional<T>(validate: Validator<T>): Validator<T | undefined> {
  return (value): value is T | undefined => value === undefined || validate(value);
}
export function oneOf<const T extends readonly string[]>(...choices: T): Validator<T[number]> {
  return (value): value is T[number] => string(value) && choices.some((choice) => choice === value);
}
