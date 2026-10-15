import { Controller, Get, Post, Patch, Body, Param, UseGuards, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { RoleGuard } from '../../common/guards/role.guard';
import { CurrentActor } from '../../common/decorators/actor.decorator';
import type { Actor } from '../../common/decorators/actor.decorator';
import { ContactsService } from '../contacts/contacts.service';
import { ROLES } from '../../common/constants/roles';

@ApiTags('Notifications')
@Controller('notifications')
@UseGuards(RoleGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    @Inject(forwardRef(() => ContactsService)) private readonly contacts: ContactsService,
  ) {}

  /** Your own notifications. `?userId=` used to return anyone's — or, omitted, everyone's. */
  @Get()
  @ApiOperation({ summary: 'Get your notifications' })
  findAll(@CurrentActor() actor: Actor) {
    return this.notificationsService.findAll({ userId: actor.id });
  }

  @Post()
  @ApiOperation({ summary: 'Notify someone you share a project with' })
  create(@Body() dto: CreateNotificationDto, @CurrentActor() actor: Actor) {
    const allowed =
      dto.userId === actor.id ||
      actor.role === ROLES.SUPERUSER ||
      this.contacts.shareTask(actor.id, dto.userId);
    if (!allowed) {
      throw new ForbiddenException('You can only notify people you share a project with.');
    }
    return this.notificationsService.create({ ...dto, fromUserId: actor.id } as any);
  }

  @Patch(':userId/read-all')
  @ApiOperation({ summary: 'Mark all your notifications as read' })
  markAllRead(@Param('userId') userId: string, @CurrentActor() actor: Actor) {
    if (userId !== actor.id) throw new ForbiddenException('You can only mark your own notifications as read.');
    return this.notificationsService.markAllRead(userId);
  }
}
