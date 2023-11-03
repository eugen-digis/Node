import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AccountSettingService } from '../account-setting/account-setting.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ReqUser } from '../auth/req-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../shared/enums';
import { User } from '../shared/types/User';
import { ValidationInputDTO } from './dto/ValidationInputDTO';
import { ValidationService } from './validation.service';

@ApiTags('Validation')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles(UserRole.User, UserRole.Admin)
@Controller('validation')
export class ValidationController {
  constructor(
    private readonly validationService: ValidationService,
    private readonly accountSettingService: AccountSettingService,
  ) {}

  @Post()
  async validate(
    @Body() input: ValidationInputDTO,
    @ReqUser() user: User,
  ) {
    const { account_id } = user;
    const accountSetting = await this.accountSettingService.getByAccountId(
      account_id,
    );

    if (accountSetting?.credits <= 0) {
      throw new HttpException(
        'Not enough credits in your account',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const { email } = input;
    return this.validationService.validate(email, account_id);
  }
}
