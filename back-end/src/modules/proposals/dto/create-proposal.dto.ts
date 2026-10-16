import { IsString, IsOptional, IsArray, MaxLength, ArrayMaxSize } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsMoney } from '../../../common/validation/money';

/** "$1,100" and 1100 both mean 1100. Anything else is left for validation to refuse. */
export function toAmount(value: any) {
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,\s]/g, '');
    if (/^\d+(\.\d+)?$/.test(cleaned)) return Number(cleaned);
  }
  return value;
}

export class CreateProposalDto {
  @ApiProperty({ example: 't3' })
  @IsString()
  taskId: string;

  /** Ignored for a worker (they bid as themselves); the invited worker when a client invites. */
  @ApiPropertyOptional({ example: 'u5' })
  @IsOptional() @IsString()
  workerId?: string;

  /**
   * The price the worker will do the whole project for. It is binding: hiring
   * makes it the contract price, and escrow is topped up or refunded to match.
   * Required on a bid; an invitation is at the project's posted budget.
   */
  @ApiPropertyOptional({ example: 1100, description: 'Contract price in USD — becomes the project budget when hired' })
  @IsOptional() @Transform(({ value }) => toAmount(value)) @IsMoney()
  bidPrice?: number;

  @ApiPropertyOptional({ example: '1 week' })
  @IsOptional() @IsString() @MaxLength(60)
  timeline?: string;

  @ApiPropertyOptional({ example: 'I can deliver clean code...' })
  @IsOptional() @IsString() @MaxLength(5000)
  coverLetter?: string;

  @ApiPropertyOptional({ example: ['Node.js', 'REST API'] })
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(60, { each: true })
  skills?: string[];

  @ApiPropertyOptional({ example: 'proposal', enum: ['proposal', 'invitation'] })
  @IsOptional() @IsString()
  type?: string;
}
