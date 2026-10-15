import { IsString, IsOptional, IsNumber, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDisputeDto {
  @ApiProperty({ example: 't1' })
  @IsString()
  taskId: string;

  @ApiPropertyOptional({ example: 'm3' })
  @IsOptional() @IsString()
  milestoneId?: string;

  /** Ignored — the caller raises the dispute. */
  @ApiPropertyOptional({ example: 'u1' })
  @IsOptional() @IsString()
  raisedBy?: string;

  @ApiPropertyOptional({ example: 'James Client' })
  @IsOptional() @IsString()
  raisedByName?: string;

  /** Ignored — always the other party on the project. */
  @ApiPropertyOptional({ example: 'u5' })
  @IsOptional() @IsString()
  againstId?: string;

  @ApiPropertyOptional({ example: 'Sarah Johnson' })
  @IsOptional() @IsString()
  againstName?: string;

  @ApiProperty({ example: 'Backend integration incomplete' })
  @IsString()
  reason: string;

  @ApiPropertyOptional({ example: '$500' })
  @IsOptional() @IsString()
  amount?: string;

  @ApiPropertyOptional({ example: 'E-commerce Website Redesign' })
  @IsOptional() @IsString()
  project?: string;

  @ApiPropertyOptional({ example: 'Backend Integration' })
  @IsOptional() @IsString()
  milestone?: string;

  @ApiPropertyOptional({ example: 'u3', description: 'The Expert Reviewer the client selected to arbitrate' })
  @IsOptional() @IsString()
  expertId?: string;

  @ApiPropertyOptional({ example: 150, description: "The client's opening offer for the reviewer's fee" })
  @IsOptional() @IsNumber() @Min(1)
  reviewerFee?: number;
}
