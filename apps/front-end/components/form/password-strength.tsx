import { memo, useMemo } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useWatch } from 'react-hook-form';
import {
  checkPasswordRules,
  PASSWORD_RULES,
} from '@app/shared/validation/rules';
import {
  MSG_PASSWORD_MUST_CONTAIN,
  MSG_PASSWORD_REQUIREMENTS,
} from '@/constants/messages';
import { fieldMessage } from '@/lib/motion';
import { cn } from '@/lib/utils';

import { Icon } from '@/components/ui/icon';

/** One entry per score, from no rule met to all of them. */
type ByScore = readonly string[] & {
  length: [unknown, ...typeof PASSWORD_RULES]['length'];
};

const STRENGTH_COLORS = [
  'bg-border',
  'bg-red-500',
  'bg-red-500',
  'bg-orange-500',
  'bg-amber-500',
  'bg-amber-700',
  'bg-emerald-500',
] as const satisfies ByScore;

const STRENGTH_TEXTS = [
  'أدخل كلمة مرور',
  'كلمة مرور ضعيفة',
  'كلمة مرور ضعيفة',
  'كلمة مرور متوسطة',
  'كلمة مرور قوية!',
  'كلمة مرور قوية جداً!!',
  'كلمة مرور قوية جداً!!',
] as const satisfies ByScore;

interface PasswordStrengthProps {
  /** The password field this meter reads. */
  name?: string;
}

const PasswordStrength = memo(
  ({ name = 'password' }: PasswordStrengthProps) => {
    const watched: unknown = useWatch({ name });
    const password = typeof watched === 'string' ? watched : '';

    const calculateStrength = useMemo(() => {
      const results = checkPasswordRules(password);
      const requirements = PASSWORD_RULES.map((rule) => ({
        rule,
        met: results[rule],
        text: MSG_PASSWORD_REQUIREMENTS[rule],
      }));

      return {
        score: requirements.filter((req) => req.met).length,
        requirements,
      };
    }, [password]);

    const meterStyle = useMemo(
      () => ({
        width: `${(calculateStrength.score / PASSWORD_RULES.length) * 100}%`,
      }),
      [calculateStrength.score]
    );

    return (
      <AnimatePresence>
        {!!password && (
          <motion.div
            variants={fieldMessage}
            initial='hidden'
            animate='show'
            exit='exit'
            className='w-full select-none'
          >
            <div className='h-3' />
            <div
              className='mb-2 h-1 overflow-hidden rounded-full bg-border'
              role='progressbar'
              aria-valuenow={calculateStrength.score}
              aria-valuemin={0}
              aria-valuemax={PASSWORD_RULES.length}
            >
              <div
                className={cn(
                  'h-full transition-all duration-500',
                  STRENGTH_COLORS[calculateStrength.score]
                )}
                style={meterStyle}
              />
            </div>

            <p className='mb-2 flex justify-between text-sm'>
              <span className='font-medium'>{MSG_PASSWORD_MUST_CONTAIN}</span>
              <span>{STRENGTH_TEXTS[calculateStrength.score]}</span>
            </p>

            <ul className='space-y-1.5' aria-label='Password requirements'>
              {calculateStrength.requirements.map((req) => (
                <li key={req.rule} className='flex items-center gap-2'>
                  {req.met ? (
                    <Icon
                      icon='solar:check-read-linear'
                      className='size-4 text-emerald-500'
                    />
                  ) : (
                    <Icon
                      icon='solar:close-linear'
                      className='size-4 text-muted-foreground/80'
                    />
                  )}
                  <span
                    className={cn(
                      'text-xs',
                      req.met ? 'text-emerald-600' : 'text-muted-foreground'
                    )}
                  >
                    {req.text}
                    <span className='sr-only'>
                      {req.met ? ' - متحقق' : ' - غير متحقق'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }
);

PasswordStrength.displayName = 'PasswordStrength';

export default PasswordStrength;
