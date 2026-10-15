import { Controller, Get, Post, Body, Query, UseGuards, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { MessagesService } from './messages.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { RoleGuard } from '../../common/guards/role.guard';
import { CurrentActor } from '../../common/decorators/actor.decorator';
import type { Actor } from '../../common/decorators/actor.decorator';
import { ContactsService } from '../contacts/contacts.service';
import { UsersService } from '../users/users.service';

@ApiTags('Messages')
@Controller('messages')
@UseGuards(RoleGuard)
export class MessagesController {
  constructor(
    private readonly messagesService: MessagesService,
    @Inject(forwardRef(() => ContactsService)) private readonly contacts: ContactsService,
    @Inject(forwardRef(() => UsersService)) private readonly users: UsersService,
  ) {}

  /** Conversations you are in. This returned every message on the platform to any caller. */
  @Get()
  @ApiOperation({ summary: 'Get your messages (supports ?taskId=)' })
  @ApiQuery({ name: 'taskId', required: false })
  findAll(@CurrentActor() actor: Actor, @Query('taskId') taskId?: string) {
    return this.messagesService.findAll({ taskId, userId: actor.id });
  }

  @Post()
  @ApiOperation({ summary: 'Send a message within a project' })
  create(@Body() dto: CreateMessageDto, @CurrentActor() actor: Actor) {
    // Sent as the caller, to someone on the same project. `senderId` and the
    // display name were taken from the body, so a message could be forged in
    // anyone's name to anyone.
    if (!this.contacts.isParticipant(actor.id, dto.taskId) || !this.contacts.isParticipant(dto.receiverId, dto.taskId)) {
      throw new ForbiddenException('Messages can only be sent between people on the same project.');
    }
    const sender = this.users.findById(actor.id);
    return this.messagesService.create({
      ...dto,
      senderId: actor.id,
      senderName: sender.name,
      senderAvatar: sender.avatar,
      senderAvatarColor: sender.avatarColor,
    });
  }
}
