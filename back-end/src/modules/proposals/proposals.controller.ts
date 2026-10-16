import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiQuery } from '@nestjs/swagger';
import { ProposalsService } from './proposals.service';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { UpdateProposalDto } from './dto/update-proposal.dto';
import { RoleGuard } from '../../common/guards/role.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentActor } from '../../common/decorators/actor.decorator';
import type { Actor } from '../../common/decorators/actor.decorator';

@ApiTags('Proposals')
@Controller('proposals')
@UseGuards(RoleGuard)
export class ProposalsController {
  constructor(private readonly proposalsService: ProposalsService) {}

  @Get()
  @ApiOperation({ summary: 'Invitations you sent or received (supports ?taskId=&workerId= filters)' })
  @ApiQuery({ name: 'taskId', required: false })
  @ApiQuery({ name: 'workerId', required: false })
  findAll(
    @Query('taskId') taskId?: string,
    @Query('workerId') workerId?: string,
    @CurrentActor() actor?: Actor,
  ) {
    return this.proposalsService.findAll({ taskId, workerId }, actor);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an invitation by ID' })
  findOne(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.proposalsService.findById(id, actor);
  }

  @Post()
  @Roles('client')
  @ApiOperation({ summary: 'Invite a worker to your open project at its posted budget' })
  create(@Body() dto: CreateProposalDto, @CurrentActor() actor: Actor) {
    return this.proposalsService.create(dto, actor);
  }

  @Patch(':id')
  @Roles('client')
  @ApiOperation({ summary: 'Withdraw an invitation the worker has not answered' })
  update(@Param('id') id: string, @Body() dto: UpdateProposalDto, @CurrentActor() actor: Actor) {
    return this.proposalsService.update(id, dto, actor);
  }

  @Post(':id/accept')
  @Roles('worker')
  @ApiOperation({ summary: 'Accept an invitation — you are hired at the posted budget' })
  accept(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.proposalsService.acceptInvitation(id, actor);
  }

  @Post(':id/decline')
  @Roles('worker')
  @ApiOperation({ summary: 'Decline an invitation' })
  decline(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.proposalsService.declineInvitation(id, actor);
  }
}
