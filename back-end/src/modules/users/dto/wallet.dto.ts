import { ApiProperty } from '@nestjs/swagger';
import { IsMoney } from '../../../common/validation/money';

export class WalletDto {
  @ApiProperty({ example: 500, description: 'Amount to add or withdraw (whole cents, up to $1,000,000)' })
  @IsMoney(0.01)
  amount: number;
}
