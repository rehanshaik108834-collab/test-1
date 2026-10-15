import { IsString, IsOptional, IsNumber, IsIn, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAuditReportDto {
  @ApiProperty({ example: 'ar1' })
  @IsString()
  auditRequestId: string;

  /** Ignored — taken from the engagement. */
  @ApiPropertyOptional({ example: 't2' })
  @IsOptional() @IsString()
  taskId?: string;

  @ApiPropertyOptional({ example: 'm6', description: 'Omitted for a whole-project or dispute audit' })
  @IsOptional() @IsString()
  milestoneId?: string;

  /** Ignored — the assigned reviewer files the report. */
  @ApiPropertyOptional({ example: 'u3' })
  @IsOptional() @IsString()
  expertId?: string;

  @ApiPropertyOptional({ example: 'pass', enum: ['pass', 'fail', 'conditional'] })
  @IsOptional() @IsIn(['pass', 'fail', 'conditional'])
  verdict?: string;

  @ApiPropertyOptional({ example: 'Pass' })
  @IsOptional() @IsString()
  overall?: string;

  @ApiPropertyOptional({ example: 'Code quality is excellent.' })
  @IsOptional() @IsString()
  findings?: string;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional() @IsNumber() @Min(0) @Max(5)
  codequality?: number;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional() @IsNumber() @Min(0) @Max(5)
  security?: number;

  @ApiPropertyOptional({ example: 4 })
  @IsOptional() @IsNumber() @Min(0) @Max(5)
  performance?: number;

  @ApiPropertyOptional({ example: 4 })
  @IsOptional() @IsNumber() @Min(0) @Max(5)
  documentation?: number;

  @ApiPropertyOptional({ example: 'Core UI Implementation' })
  @IsOptional() @IsString()
  milestoneTitle?: string;

  @ApiPropertyOptional({ example: 'Mobile App Development' })
  @IsOptional() @IsString()
  projectTitle?: string;

  @ApiPropertyOptional({ example: 'Michael Chen' })
  @IsOptional() @IsString()
  workerName?: string;
}
