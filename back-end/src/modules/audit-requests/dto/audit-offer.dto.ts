import { IsString, IsNumber, IsOptional, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateOfferDto {
  @ApiProperty({ example: 300, description: 'Proposed fee for the audit, in USD' })
  @IsNumber() @Min(1)
  amount: number;

  /** Ignored — the side is worked out from who is calling. Kept so older clients still validate. */
  @ApiPropertyOptional({ example: 'client', enum: ['client', 'expert'] })
  @IsOptional() @IsString()
  offeredBy?: string;

  @ApiPropertyOptional({ example: 'Covers the payment flow and the auth model.' })
  @IsOptional() @IsString()
  note?: string;
}

export class AcceptAuditDto {
  /** Ignored for an expert (it is the caller); required when staff assign one. */
  @ApiPropertyOptional({ example: 'u3', description: 'Expert taking the engagement' })
  @IsOptional() @IsString()
  expertId?: string;
}

export class DeclineAuditDto {
  @ApiPropertyOptional({ example: 'Outside my domain.' })
  @IsOptional() @IsString()
  reason?: string;
}
