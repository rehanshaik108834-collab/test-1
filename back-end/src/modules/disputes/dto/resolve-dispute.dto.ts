import { IsString, IsOptional, IsIn, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ResolveDisputeDto {
  /** Ignored — the verdict is given by the assigned reviewer, who is the caller. */
  @ApiPropertyOptional({ example: 'u3' })
  @IsOptional() @IsString()
  expertId?: string;

  @ApiProperty({ example: 'worker-favour', enum: ['worker-favour', 'client-favour', 'split', 'revision'] })
  @IsIn(['worker-favour', 'client-favour', 'split', 'revision'])
  verdict: string;

  @ApiProperty({ example: 'After review, milestone is complete. Releasing escrow.' })
  @IsString() @MinLength(1)
  resolution: string;
}
