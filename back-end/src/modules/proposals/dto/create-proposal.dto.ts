import { IsString, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** A client inviting a worker to one of their open projects, at its posted budget. */
export class CreateProposalDto {
  @ApiProperty({ example: 't3' })
  @IsString()
  taskId: string;

  @ApiProperty({ example: 'u5', description: 'The worker being invited' })
  @IsString()
  workerId: string;

  @ApiPropertyOptional({ example: 'Your Stripe work looked like a great fit for this.' })
  @IsOptional() @IsString() @MaxLength(2000)
  message?: string;
}
