import { ApiProperty } from '@nestjs/swagger';

class AuthUser {
  @ApiProperty({ example: '6f2b1c1e-9b3a-4f0d-9e3a-1b2c3d4e5f6a' })
  id!: string;

  @ApiProperty({ example: 'user@example.com' })
  email!: string;
}

export class AuthResponseDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken!: string;

  @ApiProperty({ type: AuthUser })
  user!: AuthUser;
}
