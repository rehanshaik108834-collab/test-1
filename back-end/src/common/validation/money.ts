import { applyDecorators } from '@nestjs/common';
import { IsNumber, Max, Min } from 'class-validator';

/**
 * The largest single amount the platform accepts anywhere — a deposit, a
 * budget, a milestone, a bid or a reviewer fee. Without a ceiling a $1e20
 * deposit was accepted and the balance lost its cents to float precision.
 */
export const MAX_AMOUNT = 1_000_000;

/** A dollar amount: whole cents, at least `min`, at most MAX_AMOUNT. */
export function IsMoney(min = 1) {
  return applyDecorators(
    IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false }, { message: '$property must be an amount in dollars and cents' }),
    Min(min),
    Max(MAX_AMOUNT, { message: `$property cannot be more than $${MAX_AMOUNT.toLocaleString('en-US')}` }),
  );
}
