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
  @ApiOperation({ summary: 'Get all proposals (supports ?taskId=&workerId=&type= filters)' })
  @ApiQuery({ name: 'taskId', required: false })
  @ApiQuery({ name: 'workerId', required: false })
  @ApiQuery({ name: 'type', required: false, enum: ['proposal', 'invitation'] })
  findAll(
    @Query('taskId') taskId?: string,
    @Query('workerId') workerId?: string,
    @Query('type') type?: string,
    @CurrentActor() actor?: Actor,
  ) {
    return this.proposalsService.findAll({ taskId, workerId, type }, actor);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get proposal by ID' })
  findOne(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.proposalsService.findById(id, actor);
  }

  @Post()
  @Roles('worker', 'client')
  @ApiOperation({ summary: 'A worker bids on an open project, or a client invites a worker to theirs' })
  create(@Body() dto: CreateProposalDto, @CurrentActor() actor: Actor) {
    return this.proposalsService.create(dto, actor);
  }

  @Patch(':id')
  @Roles('worker', 'client')
  @ApiOperation({ summary: 'Withdraw or revise your bid, or reject a bid on your project' })
  update(@Param('id') id: string, @Body() dto: UpdateProposalDto, @CurrentActor() actor: Actor) {
    return this.proposalsService.update(id, dto, actor);
  }

  @Post(':id/hire')
  @Roles('client')
  @ApiOperation({ summary: 'Hire worker (rejects other proposals, locks escrow)' })
  hire(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.proposalsService.hireWorker(id, actor);
  }

  @Post(':id/accept')
  @Roles('worker')
  @ApiOperation({ summary: 'Accept an invitation' })
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
