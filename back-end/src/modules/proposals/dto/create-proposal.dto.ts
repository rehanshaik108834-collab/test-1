import { IsString, IsOptional, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProposalDto {
  @ApiProperty({ example: 't3' })
  @IsString()
  taskId: string;

  /** Ignored for a worker (they bid as themselves); the invited worker when a client invites. */
  @ApiPropertyOptional({ example: 'u5' })
  @IsOptional() @IsString()
  workerId?: string;

  @ApiPropertyOptional({ example: 'Sarah Johnson' })
  @IsOptional() @IsString()
  workerName?: string;

  @ApiPropertyOptional({ example: 'SJ' })
  @IsOptional() @IsString()
  avatar?: string;

  @ApiPropertyOptional({ example: 'linear-gradient(135deg,#6366f1,#4f46e5)' })
  @IsOptional() @IsString()
  avatarColor?: string;




  @ApiPropertyOptional({ example: '$1,100' })
  @IsOptional() @IsString()
  bidPrice?: string;

  @ApiPropertyOptional({ example: '1 week' })
  @IsOptional() @IsString()
  timeline?: string;

  @ApiPropertyOptional({ example: 'I can deliver clean code...' })
  @IsOptional() @IsString()
  coverLetter?: string;

  @ApiPropertyOptional({ example: ['Node.js', 'REST API'] })
  @IsOptional() @IsArray()
  skills?: string[];





  @ApiPropertyOptional({ example: 'proposal', enum: ['proposal', 'invitation'] })
  @IsOptional() @IsString()
  type?: string;
}
