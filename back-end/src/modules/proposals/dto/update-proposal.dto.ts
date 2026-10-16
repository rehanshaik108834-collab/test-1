import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** The only change a client makes to an invitation: withdrawing it before it is answered. */
export class UpdateProposalDto {
  @ApiProperty({ example: 'withdrawn', enum: ['withdrawn'] })
  @IsIn(['withdrawn'])
  status: string;
}
