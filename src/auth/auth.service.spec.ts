import { Test } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';

const usersMock = {
  findByEmail: jest.fn(),
  create: jest.fn(),
};
const jwtMock = { sign: jest.fn().mockReturnValue('signed.jwt.token') };

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersMock },
        { provide: JwtService, useValue: jwtMock },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  it('hashes the password (never stores plain text) and returns a token', async () => {
    usersMock.findByEmail.mockResolvedValue(null);
    usersMock.create.mockImplementation((email: string, hash: string) =>
      Promise.resolve({ id: 'u1', email, password: hash }),
    );

    const res = await service.register({
      email: 'a@b.com',
      password: 'StrongPass123',
    });

    const storedHash = usersMock.create.mock.calls[0][1];
    expect(storedHash).not.toBe('StrongPass123');
    expect(await bcrypt.compare('StrongPass123', storedHash)).toBe(true);
    expect(res.accessToken).toBe('signed.jwt.token');
  });

  it('rejects registration when the email is taken (409)', async () => {
    usersMock.findByEmail.mockResolvedValue({ id: 'u1', email: 'a@b.com' });
    await expect(
      service.register({ email: 'a@b.com', password: 'StrongPass123' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects login with a wrong password (401)', async () => {
    const hash = await bcrypt.hash('correct-password', 10);
    usersMock.findByEmail.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      password: hash,
    });
    await expect(
      service.login({ email: 'a@b.com', password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
